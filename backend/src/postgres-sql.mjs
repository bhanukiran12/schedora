export function postgresQuery(sql) {
  let position = 0;
  let result = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g, token => token === '?' ? '$' + (++position) : token);
  result = result.replace(/(\$\d+) IS (NOT )?NULL/g, '$1::text IS $2NULL');
  result = result.replace(/\bIFNULL\(/gi, 'COALESCE(');
  result = result.replace(/\bgroup_concat\(/gi, 'string_agg(');
  result = result.replace(/\binstr\(/gi, 'strpos(').replace(/\bmax\(1,/gi, 'greatest(1,');
  result = result.replace(/json_each\(c\.tags\)/g, 'json_array_elements_text(c.tags::json) AS tag(value)').replace(/json_each\.value/g, 'tag.value');
  if (/INSERT OR IGNORE/i.test(result)) result = result.replace(/INSERT OR IGNORE/i, 'INSERT').replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  return result;
}

// Tables of migration 005 (Schedora Meet video and credits), created by the postgres_v4 upgrade.
export const VIDEO_TABLES = ['video_rooms', 'video_invites', 'video_participants', 'video_usage_intervals', 'video_provider_events', 'video_provider_ops',
  'credit_accounts', 'credit_lots', 'credit_reservations', 'credit_allocations', 'credit_ledger', 'video_usage_records', 'credit_recharge_orders', 'credit_payment_events'];

export function postgresUpgrade(tables, indexes, extra = []) {
  return [...postgresSchema(tables, indexes).slice(0, -1), ...extra];
}

export function postgresSchema(tables, indexes) {
  const foreignKeys = [];
  const statements = tables.map(table => {
    let sql = table.sql.replace(/\bINTEGER\b/gi, 'BIGINT').replace(/ COLLATE NOCASE/gi, '');
    sql = sql.replace(/(\b\w+\b)(\s+TEXT(?:\s+NOT NULL)?)\s+REFERENCES\s+("?\w+"?)\((\w+)\)(\s+ON DELETE (?:CASCADE|SET NULL|RESTRICT))?/gi,
      (_, column, type, target, targetColumn, action = '') => {
        foreignKeys.push('ALTER TABLE "' + table.name + '" ADD FOREIGN KEY (' + column + ') REFERENCES ' + target + '(' + targetColumn + ')' + action);
        return column + type;
      });
    return sql;
  });
  return [...statements, ...foreignKeys, ...indexes.map(index => index.sql.replace(/\bIFNULL\(/gi, 'COALESCE(')), 'CREATE UNIQUE INDEX users_email_lower ON users (lower(email))'];
}
