import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.mjs';
import { requireMember } from './workspaces.mjs';
import { listEventTypes } from '../meet/event-types.mjs';
import { computeAvailability, hostBook, hostCancel, listBookings, loadEventType } from '../meet/bookings.mjs';
import { getContact, listContacts } from './contacts.mjs';
import { addDays, isValidDate, localDate } from '../time.mjs';

// Model Context Protocol server (Streamable HTTP transport, stateless JSON responses).
// Authenticated with a workspace API key, so AI assistants act exactly as that member would.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  { name: 'list_event_types', description: 'List the meeting types (event types) the member can book or manage, with their ids and booking links.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_available_times', description: 'Get open start times (UTC ISO 8601) for an event type over the next days.',
    inputSchema: { type: 'object', properties: { event_type_id: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD, defaults to today' }, days: { type: 'integer', minimum: 1, maximum: 31 } }, required: ['event_type_id'] } },
  { name: 'book_meeting', description: 'Book a meeting for someone at an available start time. Sends confirmations to the invitee and hosts.',
    inputSchema: { type: 'object', properties: { event_type_id: { type: 'string' }, start: { type: 'string', description: 'UTC ISO 8601 start, from get_available_times' }, name: { type: 'string' }, email: { type: 'string' }, timezone: { type: 'string', description: 'Invitee IANA time zone' }, notes: { type: 'string' } }, required: ['event_type_id', 'start', 'name', 'email', 'timezone'] } },
  { name: 'list_meetings', description: 'List upcoming, past or canceled meetings visible to the member.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['upcoming', 'past', 'canceled'] } } } },
  { name: 'cancel_meeting', description: 'Cancel a booking by its id and notify the invitee.', inputSchema: { type: 'object', properties: { booking_id: { type: 'string' }, reason: { type: 'string' } }, required: ['booking_id'] } },
  { name: 'find_contacts', description: 'Search contacts by name, email or company.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_contact', description: 'Get a contact with meeting history, form responses, notes and tasks.', inputSchema: { type: 'object', properties: { contact_id: { type: 'string' } }, required: ['contact_id'] } }
];

function runTool(app, ctx, actor, name, args = {}) {
  const ws = actor.workspace.id;
  switch (name) {
    case 'list_event_types':
      return listEventTypes(app, ws, actor).filter(type => !type.managed_template).map(type => ({ id: type.id, title: type.title, kind: type.kind, duration_min: type.duration_min, published: type.published,
        link: `${app.config.baseUrl}/meet/${actor.workspace.slug}/${type.slug}`, hosts: type.hosts.map(host => host.name) }));
    case 'get_available_times': {
      const eventType = loadEventType(app, args.event_type_id);
      if (!eventType || eventType.workspace_id !== ws || !listEventTypes(app, ws, actor).some(type => type.id === eventType.id)) throw new HttpError(404, 'not_found', 'Event type not found.');
      const from = isValidDate(args.from) ? args.from : localDate(app.now(), eventType.timezone);
      const days = Math.min(31, Math.max(1, Number(args.days) || 7));
      const { slots } = computeAvailability(app, eventType, { fromDate: from, toDate: addDays(from, days) });
      return { timezone: eventType.timezone, slots: [...slots.keys()].slice(0, 200).map(ms => new Date(ms).toISOString()) };
    }
    case 'book_meeting': {
      const { booking } = hostBook(app, ws, actor, { event_type_id: args.event_type_id, start: args.start, name: args.name, email: args.email, timezone: args.timezone, notes: args.notes }, 'mcp' + randomUUID().replace(/-/g, ''));
      return { booking_id: booking.id, reference: booking.reference, status: booking.status, starts_at: new Date(booking.starts_at).toISOString() };
    }
    case 'list_meetings':
      return listBookings(app, ws, actor, ['upcoming', 'past', 'canceled'].includes(args.scope) ? args.scope : 'upcoming').slice(0, 50).map(booking => ({
        booking_id: booking.id, reference: booking.reference, status: booking.status, starts_at: new Date(booking.starts_at).toISOString(), event: booking.event_title,
        invitee: { name: booking.invitee_name, email: booking.invitee_email }, hosts: booking.host_name, answers: booking.answers }));
    case 'cancel_meeting':
      hostCancel(app, ws, actor, args.booking_id, { reason: args.reason || '' });
      return { canceled: true };
    case 'find_contacts':
      return listContacts(app, ws, { search: String(args.query || ''), limit: 25 }).map(contact => ({ id: contact.id, name: contact.name, email: contact.email, company: contact.company, meetings: contact.meeting_count }));
    case 'get_contact':
      return getContact(app, ws, args.contact_id);
    default:
      throw new HttpError(400, 'unknown_tool', `Unknown tool: ${name}`);
  }
}

// Handles one JSON-RPC message (or a batch). Returns null for notifications.
export function handleMcp(app, ctx, message) {
  if (Array.isArray(message)) return message.map(item => handleMcp(app, ctx, item)).filter(Boolean);
  const { id, method, params = {} } = message || {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const error = (code, text) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'Invalid request');
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'schedora-meet', version: '1.0.0' },
        instructions: 'Tools for Meet by Schedora: find event types and free times, book or cancel meetings, and look up contacts. Times are UTC ISO 8601.'
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const actor = { ...requireMember(app, ctx.user, ctx.apiKey.workspaceId), userId: ctx.user.id };
        const result = runTool(app, ctx, actor, params.name, params.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result });
      } catch (failure) {
        return reply({ content: [{ type: 'text', text: failure.message || 'Tool failed.' }], isError: true });
      }
    }
    default: return error(-32601, `Method not found: ${method}`);
  }
}
