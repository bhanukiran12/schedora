import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { EMAIL_REPORT_COLUMNS, EMAIL_REPORT_TABLES, ENQUIRY_FEED_INDEXES, FORM_ASSET_TABLES, FORM_THEME_TABLES, RESPONDENT_TABLES, SESSION_OFFER_TABLES, FORMS_V5_COLUMNS, FORMS_V5_TABLES, MONITORING_TABLES, ONBOARDING_TABLES, postgresSchema, postgresUpgrade, TASK_ASSIGNEE_INDEXES, VIDEO_TABLES } from './postgres-sql.mjs';
import { openDatabase } from './db.mjs';

const FORM_PAYMENT_TABLES = ['form_payments', 'form_payment_attempts', 'form_payment_events'];
const MESSAGE_CONSENT_TABLES = ['form_message_consents', 'messaging_opt_outs'];
const SHEETS_SYNC_TABLES = ['form_google_syncs', 'form_google_sync_rows'];
const FLOW_V1_TABLES = ['flow_versions', 'flow_run_steps', 'flow_waits', 'flow_approvals', 'flow_round_robin', 'flow_inbound_hooks', 'flow_inbound_deliveries', 'flow_schedules', 'flow_provider_checks'];
// Flow v1 on existing databases: the base tables gain columns and lose the single-action checks.
const FLOW_V1_COLUMNS = [
  'ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_action_type_check',
  ...['definition TEXT', 'draft_revision BIGINT NOT NULL DEFAULT 0', 'published_version BIGINT', 'created_by TEXT', 'template TEXT', 'auto_pause BIGINT NOT NULL DEFAULT 0', 'consecutive_failures BIGINT NOT NULL DEFAULT 0', 'alerted_at BIGINT', 'enabled_at BIGINT'].map(column => 'ALTER TABLE flows ADD COLUMN IF NOT EXISTS ' + column),
  'ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_status_check',
  "ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'retrying', 'failed', 'waiting', 'needs_approval', 'skipped', 'canceled'))",
  ...['version BIGINT', 'trigger_data TEXT', 'depth BIGINT NOT NULL DEFAULT 0', 'lease_owner TEXT', 'lease_until BIGINT', 'reason TEXT', 'finished_at BIGINT'].map(column => 'ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS ' + column),
  'CREATE INDEX IF NOT EXISTS flow_runs_flow ON flow_runs(flow_id, created_at)',
  ...['payload TEXT', 'origin TEXT', 'depth BIGINT NOT NULL DEFAULT 0'].map(column => 'ALTER TABLE outbox ADD COLUMN IF NOT EXISTS ' + column)
];

export function openPostgres(connectionString, { ca, schemaName = 'schedora' } = {}) {
  if (!/^schedora(?:_test_[a-z0-9]+)?$/.test(schemaName)) throw new Error('Invalid Schedora database schema.');
  const template = openDatabase(':memory:');
  let schema;
  let upgrades;
  try {
    const tables = template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'");
    const indexes = template.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
    // Tables added after the first PostgreSQL release are created by versioned upgrade steps, the
    // same way for new and existing databases.
    const workbookTables = ['form_workbooks', 'form_workbook_versions', 'form_workbook_links', 'form_workbook_comments'];
    const standaloneTables = ['workbooks', 'workbook_access', 'workbook_versions', 'workbook_comments', 'workbook_form_links'];
    const later = [...VIDEO_TABLES, ...FORMS_V5_TABLES, ...MONITORING_TABLES, ...EMAIL_REPORT_TABLES, ...ONBOARDING_TABLES, ...FORM_ASSET_TABLES, ...SESSION_OFFER_TABLES, ...FORM_THEME_TABLES, ...RESPONDENT_TABLES, ...workbookTables, ...standaloneTables, 'form_response_edits', 'form_uploads','workbook_trash','form_ai_requests','booking_attendance','workbook_booking_links','booking_message_consent','form_resume_drafts','qualify_starters','form_payments','form_payment_attempts','form_payment_events','form_message_consents','messaging_opt_outs','form_google_syncs','form_google_sync_rows','meeting_followups', ...FLOW_V1_TABLES];
    schema = postgresSchema(tables.filter(table => !later.includes(table.name)), indexes.filter(index => !later.includes(index.tbl_name)));
    upgrades = [{ name: 'postgres_v4_meet_video', statements: postgresUpgrade(tables.filter(table => VIDEO_TABLES.includes(table.name)), indexes.filter(index => VIDEO_TABLES.includes(index.tbl_name)), [
      "CREATE FUNCTION credit_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credit_ledger_immutable'; END $$",
      'CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION credit_ledger_immutable()'
    ]) }, { name: 'postgres_v5_forms_reliability', statements: [...FORMS_V5_COLUMNS,
      ...postgresUpgrade(tables.filter(table => FORMS_V5_TABLES.includes(table.name)), indexes.filter(index => FORMS_V5_TABLES.includes(index.tbl_name)))] },
      { name: 'postgres_v6_email_transport', statements: ['ALTER TABLE emails ADD COLUMN IF NOT EXISTS accepted_transport TEXT'] },
      { name: 'postgres_v7_monitoring', statements: postgresUpgrade(tables.filter(table => MONITORING_TABLES.includes(table.name)), indexes.filter(index => MONITORING_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v8_email_delivery_reports', statements: [...EMAIL_REPORT_COLUMNS,
        ...postgresUpgrade(tables.filter(table => EMAIL_REPORT_TABLES.includes(table.name)), indexes.filter(index => EMAIL_REPORT_TABLES.includes(index.tbl_name)))] },
      { name: 'postgres_v9_enquiry_feed', statements: ENQUIRY_FEED_INDEXES },
      { name: 'postgres_v10_task_deadlines', statements: TASK_ASSIGNEE_INDEXES },
      { name: 'postgres_v11_live_onboarding', statements: postgresUpgrade(tables.filter(table => ONBOARDING_TABLES.includes(table.name)), indexes.filter(index => ONBOARDING_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v12_calendar_success', statements: ['ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS last_success_at BIGINT'] },
      { name: 'postgres_v13_form_assets', statements: postgresUpgrade(tables.filter(table => FORM_ASSET_TABLES.includes(table.name)), indexes.filter(index => FORM_ASSET_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v14_session_offers', statements: postgresUpgrade(tables.filter(table => SESSION_OFFER_TABLES.includes(table.name)), indexes.filter(index => SESSION_OFFER_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v15_form_themes', statements: postgresUpgrade(tables.filter(table => FORM_THEME_TABLES.includes(table.name)), indexes.filter(index => FORM_THEME_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v16_response_attribution', statements: ['ALTER TABLE responses ADD COLUMN IF NOT EXISTS attribution TEXT'] },
      { name: 'postgres_v17_respondent_signin', statements: ["ALTER TABLE forms ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'public'", 'ALTER TABLE responses ADD COLUMN IF NOT EXISTS respondent TEXT',
        ...postgresUpgrade(tables.filter(table => RESPONDENT_TABLES.includes(table.name)), indexes.filter(index => RESPONDENT_TABLES.includes(index.tbl_name)))] },
      { name: 'postgres_v18_form_workbooks', statements: [
        // Some existing databases have the original workbook table from the generated base.
        ...tables.filter(table => workbookTables.includes(table.name)).map(table => table.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ').replace(/\bINTEGER\b/gi, 'BIGINT')),
        ...indexes.filter(index => workbookTables.includes(index.tbl_name)).map(index => index.sql.replace(/^CREATE (UNIQUE )?INDEX /i, 'CREATE $1INDEX IF NOT EXISTS '))
      ] }, { name: 'postgres_v19_standalone_workbooks', statements: postgresUpgrade(
        tables.filter(table => standaloneTables.includes(table.name)), indexes.filter(index => standaloneTables.includes(index.tbl_name))
      ) }, { name: 'postgres_v20_form_response_edits', statements: postgresUpgrade(
        tables.filter(table => table.name === 'form_response_edits'), indexes.filter(index => index.tbl_name === 'form_response_edits')
      ) }, { name: 'postgres_v21_form_uploads', statements: postgresUpgrade(
        tables.filter(table => table.name === 'form_uploads'), indexes.filter(index => index.tbl_name === 'form_uploads')
      ) }, { name: 'postgres_v22_upload_response_edits', statements: [
        'ALTER TABLE form_uploads ADD COLUMN IF NOT EXISTS edit_response_id TEXT',
        'CREATE INDEX IF NOT EXISTS form_uploads_edit_response ON form_uploads(edit_response_id)'
      ] },{name:'postgres_v23_workbook_trash',statements:postgresUpgrade(tables.filter(table=>table.name==='workbook_trash'),indexes.filter(index=>index.tbl_name==='workbook_trash'))},{name:'postgres_v24_product_tools',statements:postgresUpgrade(tables.filter(table=>['form_ai_requests','booking_attendance','workbook_booking_links'].includes(table.name)),indexes.filter(index=>['form_ai_requests','booking_attendance','workbook_booking_links'].includes(index.tbl_name)))},{name:'postgres_v25_message_consent',statements:postgresUpgrade(tables.filter(table=>table.name==='booking_message_consent'),[])},{name:'postgres_v26_whatsapp_workflows',statements:["ALTER TABLE meet_workflows DROP CONSTRAINT IF EXISTS meet_workflows_channel_check","ALTER TABLE meet_workflows ADD CONSTRAINT meet_workflows_channel_check CHECK (channel IN ('email','sms','whatsapp'))"]},{name:'postgres_v27_form_resume',statements:postgresUpgrade(tables.filter(table=>table.name==='form_resume_drafts'),indexes.filter(index=>index.tbl_name==='form_resume_drafts'))},{name:'postgres_v28_qualify_starters',statements:postgresUpgrade(tables.filter(table=>table.name==='qualify_starters'),[])},
      { name: 'postgres_v29_form_payments', statements: ['ALTER TABLE responses ADD COLUMN IF NOT EXISTS payment_status TEXT', ...postgresUpgrade(tables.filter(table => FORM_PAYMENT_TABLES.includes(table.name)).sort((a, b) => FORM_PAYMENT_TABLES.indexOf(a.name) - FORM_PAYMENT_TABLES.indexOf(b.name)), indexes.filter(index => FORM_PAYMENT_TABLES.includes(index.tbl_name)))] },
      { name: 'postgres_v30_form_message_consent', statements: postgresUpgrade(tables.filter(table => MESSAGE_CONSENT_TABLES.includes(table.name)), indexes.filter(index => MESSAGE_CONSENT_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v31_google_sheets_sync', statements: postgresUpgrade(tables.filter(table => SHEETS_SYNC_TABLES.includes(table.name)), indexes.filter(index => SHEETS_SYNC_TABLES.includes(index.tbl_name))) },
      { name: 'postgres_v32_meeting_followups', statements: postgresUpgrade(tables.filter(table => table.name === 'meeting_followups'), indexes.filter(index => index.tbl_name === 'meeting_followups')) },
      { name: 'postgres_v33_flow_v1', statements: [...FLOW_V1_COLUMNS, ...postgresUpgrade(tables.filter(table => FLOW_V1_TABLES.includes(table.name)), indexes.filter(index => FLOW_V1_TABLES.includes(index.tbl_name)))] }];
  } finally { template.close(); }
  const { port1, port2 } = new MessageChannel();
  const state = new SharedArrayBuffer(4);
  const signal = new Int32Array(state);
  const worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), { workerData: { port: port2, state, connectionString, ca, schemaName, upgrades }, transferList: [port2], execArgv: [] });
  worker.unref();
  worker.on('error', () => {});
  let closed = false;
  function call(request) {
    if (closed) throw new Error('PostgreSQL connection is closed.');
    Atomics.store(signal, 0, 0);
    port1.postMessage(request);
    if (Atomics.wait(signal, 0, 0, 45000) === 'timed-out') {
      closed = true; worker.terminate(); port1.close();
      throw new Error('PostgreSQL request timed out; connection closed. Check the database before retrying writes.');
    }
    const response = receiveMessageOnPort(port1)?.message;
    if (!response) throw new Error('PostgreSQL worker returned no response.');
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  try { call({ operation: 'init', schema }); }
  catch (error) { closed = true; worker.terminate(); port1.close(); throw error; }
  let depth = 0;
  const query = (sql, params = []) => call({ operation: 'query', sql, params });
  return {
    dialect: 'postgres',
    get: (sql, ...params) => query(sql, params).rows[0],
    all: (sql, ...params) => query(sql, params).rows,
    run: (sql, ...params) => ({ changes: query(sql, params).changes }),
    exec: sql => query(sql),
    transaction(fn) {
      const previousDepth = depth;
      const savepoint = 'sp' + previousDepth;
      query(previousDepth === 0 ? 'BEGIN' : 'SAVEPOINT ' + savepoint);
      depth = previousDepth + 1;
      try {
        if (previousDepth === 0) query('SELECT pg_advisory_xact_lock(724516, 2)');
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('Database transaction callbacks must be synchronous.');
        query(previousDepth === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          if (previousDepth === 0) query('ROLLBACK');
          else { query('ROLLBACK TO SAVEPOINT ' + savepoint); query('RELEASE SAVEPOINT ' + savepoint); }
        } catch {}
        throw error;
      } finally { depth = previousDepth; }
    },
    close() { if (!closed) { try { call({ operation: 'close' }); } finally { closed = true; worker.terminate(); port1.close(); } } }
  };
}
