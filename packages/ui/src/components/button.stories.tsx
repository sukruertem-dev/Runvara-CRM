import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from './button';

const meta: Meta<typeof Button> = {
  title: 'Temel/Button',
  component: Button,
  args: { children: 'Kaydet', variant: 'primary', size: 'md' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button icon={<Plus aria-hidden size={16} />}>Yeni görev</Button>
      <Button variant="secondary">İptal</Button>
      <Button variant="ghost">Daha fazla</Button>
      <Button variant="danger" icon={<Trash2 aria-hidden size={16} />}>
        Sil
      </Button>
      <Button loading>Kaydediliyor</Button>
      <Button disabled>Devre dışı</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button size="sm">Küçük</Button>
      <Button size="md">Orta</Button>
      <Button size="lg">Büyük</Button>
    </div>
  ),
};

export const IconOnly: Story = {
  render: () => (
    <div className="flex gap-2">
      <IconButton label="Yeni görev">
        <Plus aria-hidden size={18} />
      </IconButton>
      <IconButton label="Sil" variant="danger">
        <Trash2 aria-hidden size={18} />
      </IconButton>
    </div>
  ),
};
