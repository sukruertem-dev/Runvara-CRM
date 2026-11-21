import { TaskPatch, type AutomationRuleDefinition } from '@flexa/contracts';
import { sql, type Db } from '@flexa/db';
import type { FieldRegistry } from '@flexa/query-lang';
import { ProblemError } from '../../common/problem';
import type { RecordShape, ShareType } from '../../common/record-access';
import { CRM, crmRegistry, isCrmType } from '../crm/crm-objects';
import { PATCH_SCHEMAS } from '../crm/crm.service';
import { loadFieldDefs, taskRegistry } from '../tasks/task-fields';
import { TASK_SHAPE } from '../tasks/tasks.service';

export type RuleDefinition = AutomationRuleDefinition;
export type RuleAction = RuleDefinition['actions'][number];

export const shapeOf = (type: ShareType): RecordShape => (type === 'task' ? TASK_SHAPE : CRM[type].shape);

/** RQL fields a rule condition may use: the record's own fields plus its account's (ilişkili kayıt alanları).
 *  Only rule conditions get the related fields — they run as the rule owner and never return data. */
export async function conditionRegistry(tx: Db, type: ShareType): Promise<FieldRegistry> {
  const defs = await loadFieldDefs(tx, type);
  const own = type === 'task' ? taskRegistry(defs) : crmRegistry(CRM[type], defs);
  const accountRef = type === 'opportunity' || type === 'case' ? sql`t.account_id`
    : type === 'contact' ? sql`(SELECT acr.account_id FROM account_contact_roles acr WHERE acr.tenant_id = t.tenant_id AND acr.contact_id = t.id ORDER BY acr.is_primary DESC, acr.created_at LIMIT 1)`
      : null;
  if (!accountRef) return own;
  return {
    ...own,
    'account.name': { sql: sql`(SELECT a.name FROM accounts a WHERE a.id = ${accountRef})`, type: 'text', sortable: false },
    'account.industry': { sql: sql`(SELECT a.industry FROM accounts a WHERE a.id = ${accountRef})`, type: 'text', sortable: false },
    'account.domain': { sql: sql`(SELECT a.domain::text FROM accounts a WHERE a.id = ${accountRef})`, type: 'text', sortable: false },
  };
}

/** The PATCH body an `update_field` action stands for, validated by the object's own patch schema. */
export function updateBody(type: ShareType, field: string, value: unknown): Record<string, unknown> {
  const body = field.startsWith('custom.') ? { custom: { [field.slice('custom.'.length)]: value } } : { [field]: value };
  const schema = type === 'task' ? TaskPatch : isCrmType(type) ? PATCH_SCHEMAS[type] : null;
  if (!schema) throw new ProblemError('RULE_DEFINITION_INVALID', `unknown resource ${type}`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ProblemError('RULE_DEFINITION_INVALID', `update_field ${field}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}
