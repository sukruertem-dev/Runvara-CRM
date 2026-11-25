import {
  BarChart3,
  Briefcase,
  CheckSquare,
  ClipboardCheck,
  Gauge,
  Link2,
  Monitor,
  Package,
  Phone,
  PhoneOutgoing,
  Plug,
  ShoppingBag,
  Sparkles,
  Square,
  Stamp,
  Target,
  Users,
  Zap,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

/** Module catalogue icon names (packages/modules catalog.json) → lucide components. */
const ICONS: Record<string, LucideIcon> = {
  'check-square': CheckSquare,
  users: Users,
  package: Package,
  briefcase: Briefcase,
  'shopping-bag': ShoppingBag,
  target: Target,
  stamp: Stamp,
  gauge: Gauge,
  phone: Phone,
  monitor: Monitor,
  'phone-outgoing': PhoneOutgoing,
  'clipboard-check': ClipboardCheck,
  plug: Plug,
  zap: Zap,
  'bar-chart': BarChart3,
  link: Link2,
  sparkle: Sparkles,
};

export const MODULE_ICON_NAMES = Object.keys(ICONS);

export function ModuleIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = ICONS[name] ?? Square;
  return <Icon aria-hidden {...props} />;
}
