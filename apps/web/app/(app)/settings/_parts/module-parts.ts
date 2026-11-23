import { moduleLabel, t } from '../../../../lib/i18n';

// Shared by the module catalogue and the onboarding wizard.

export const MODULE_ICONS: Record<string, string> = {
  core: 'check-square', crm: 'users', sales_b2b: 'briefcase', sales_b2c: 'shopping-bag', sales_tracking: 'target', call_center: 'phone',
  dialer: 'phone-outgoing', call_qa: 'clipboard-check', data_service: 'plug', automation_sla: 'zap', reporting_advanced: 'bar-chart',
  api_webhooks: 'link', ai_assistant: 'sparkle',
};

export const ENTITLEMENT_TONE = { included: 'success', add_on: 'accent', available_add_on: 'warning', not_in_plan: 'neutral' } as const;
export const groupsText = (groups: readonly (readonly string[])[]): string =>
  groups.map((g) => g.map(moduleLabel).join(` ${t('modules.or')} `)).join(', ');
