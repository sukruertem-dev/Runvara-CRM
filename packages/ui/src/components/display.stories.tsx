import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox } from 'lucide-react';
import tokens from '../../tokens.json';
import { Button } from './button';
import { Alert, Avatar, EmptyState, ErrorState, Kbd, PriorityBadge, RoleBadge, SegmentBadge, Skeleton, StatusBadge } from './display';
import { MODULE_ICON_NAMES, ModuleIcon } from './icon';

const meta: Meta = { title: 'Temel/Gösterim' };
export default meta;
type Story = StoryObj;

export const Badges: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <SegmentBadge segment="b2b" label="Kurumsal" />
        <SegmentBadge segment="b2c" label="Bireysel" />
      </div>
      <div className="flex flex-wrap gap-2">
        <RoleBadge role="admin" label="Admin" />
        <RoleBadge role="manager" label="Yönetici" />
        <RoleBadge role="sales_rep" label="Satış Temsilcisi" />
        <RoleBadge role="call_agent" label="Çağrı Temsilcisi" />
        <RoleBadge role="analyst" label="Analist" />
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusBadge category="open" label="Yapılacak" />
        <StatusBadge category="in_progress" label="Devam ediyor" />
        <StatusBadge category="closed" label="Tamamlandı" />
        <StatusBadge category="in_progress" colorToken="warning" label="İncelemede" />
      </div>
      <div className="flex flex-wrap gap-2">
        {['Yok', 'Düşük', 'Orta', 'Yüksek', 'Acil'].map((l, i) => (
          <PriorityBadge key={l} priority={i} label={l} />
        ))}
      </div>
    </div>
  ),
};

export const Avatars: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Avatar name="Ayşe Yılmaz" />
      <Avatar name="İsmail Öztürk" size={36} />
      <Avatar name="Zeynep" size={44} />
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-card border border-line bg-surface">
        <EmptyState icon={Inbox} title="Henüz görev yok" description="İlk görevi oluşturun; ekibiniz burada görür." action={<Button size="sm">Yeni görev</Button>} />
      </div>
      <div className="rounded-card border border-line bg-surface">
        <ErrorState title="Görevler yüklenemedi" description="Bağlantınızı kontrol edip yeniden deneyin." retryLabel="Yeniden dene" onRetry={() => undefined} />
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="flex flex-col gap-2">
        <Alert kind="info">Bu kayıt başka bir kullanıcı tarafından güncellendi.</Alert>
        <Alert kind="warning">WIP limiti aşıldı (5/4).</Alert>
        <Alert kind="error">Kaydedilemedi.</Alert>
        <Alert kind="success">Kaydedildi.</Alert>
      </div>
      <p className="text-sm text-fg-muted">
        Klavye: <Kbd>C</Kbd> yeni görev, <Kbd>/</Kbd> arama, <Kbd>?</Kbd> yardım
      </p>
    </div>
  ),
};

export const ModuleIcons: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      {MODULE_ICON_NAMES.map((n) => (
        <span key={n} className="flex items-center gap-2 text-sm">
          <ModuleIcon name={n} size={18} /> {n}
        </span>
      ))}
    </div>
  ),
};

/** Every colour token, from tokens.json (the single source). */
export const Tokens: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {Object.keys(tokens.color.light).map((k) => (
        <div key={k} className="overflow-hidden rounded-input border border-line bg-surface text-xs">
          <div className="h-10" style={{ background: `var(--${k})` }} />
          <div className="px-2 py-1 font-mono">--{k}</div>
        </div>
      ))}
    </div>
  ),
};
