import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckSquare, LogOut, Moon, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';
import { CommandDialog, CommandEmpty, CommandGroup, CommandItem } from './command';
import { Kbd } from './display';
import { Field, Input } from './input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  DialogClose,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from './overlay';
import { useToast } from './toast';

const meta: Meta = { title: 'Katmanlar/Overlay' };
export default meta;
type Story = StoryObj;

export const DialogStory: Story = {
  name: 'Dialog',
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button icon={<Plus aria-hidden size={16} />}>Yeni görev</Button>
      </DialogTrigger>
      <DialogContent title="Yeni görev" description="Görev oluşturulunca listede görünür." closeLabel="Kapat">
        <Field label="Başlık">
          <Input autoFocus placeholder="Görev başlığı" />
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">İptal</Button>
          </DialogClose>
          <Button>Oluştur</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const PopoverAndTooltip: Story = {
  render: () => (
    <div className="flex gap-3">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="secondary">Filtre</Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 text-sm">Durum, atanan ve öncelik filtreleri burada.</PopoverContent>
      </Popover>
      <Tooltip content="Yeni görev (C)">
        <Button variant="ghost">İpucu</Button>
      </Tooltip>
    </div>
  ),
};

export const Menu: Story = {
  render: function Render() {
    const [theme, setTheme] = useState('system');
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">Ayşe Yılmaz</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Tema</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="system">Sistem</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Açık</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon aria-hidden size={14} /> Koyu
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <Settings aria-hidden size={14} /> Güvenlik
          </DropdownMenuItem>
          <DropdownMenuItem>
            <LogOut aria-hidden size={14} /> Çıkış yap
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

export const Toasts: Story = {
  render: function Render() {
    const { toast } = useToast();
    return (
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => toast({ title: 'Görev kaydedildi', kind: 'success' })}>
          Başarılı
        </Button>
        <Button variant="secondary" onClick={() => toast({ title: '3 görev silindi', action: { label: 'Geri al', onAction: () => toast({ title: 'Geri alındı' }) } })}>
          Geri alınabilir
        </Button>
        <Button variant="secondary" onClick={() => toast({ title: 'Kaydedilemedi', description: 'Bağlantı koptu; yeniden deneyin.', kind: 'error' })}>
          Hata
        </Button>
      </div>
    );
  },
};

export const CommandPalette: Story = {
  render: function Render() {
    const [open, setOpen] = useState(true);
    const [q, setQ] = useState('');
    return (
      <>
        <Button variant="secondary" onClick={() => { setOpen(true); }}>
          Komut paleti <Kbd>Ctrl K</Kbd>
        </Button>
        <CommandDialog open={open} onOpenChange={setOpen} title="Komut paleti" placeholder="Ara veya komut yazın…" value={q} onValueChange={setQ} footer={<span>↑↓ gezin · Enter seç · Esc kapat</span>}>
          <CommandEmpty>Sonuç yok</CommandEmpty>
          <CommandGroup heading="Eylemler">
            <CommandItem value="new-task" icon={<Plus size={16} />} hint={<Kbd>C</Kbd>} onSelect={() => { setOpen(false); }}>
              Yeni görev
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Git">
            <CommandItem value="tasks" icon={<CheckSquare size={16} />} onSelect={() => { setOpen(false); }}>
              Görevler
            </CommandItem>
          </CommandGroup>
        </CommandDialog>
      </>
    );
  },
};
