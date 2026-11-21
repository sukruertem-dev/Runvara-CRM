import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { CommandDialog, CommandGroup, CommandItem } from './command';
import { initials, PriorityBadge, SegmentBadge, StatusBadge } from './display';
import { Combobox, Select } from './form-controls';
import { Field, Input } from './input';
import { Dialog, DialogContent, DialogTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './overlay';
import { ToastProvider, useToast } from './toast';

/** Serious and critical axe violations only (Faz 6 acceptance: "no critical violations"). */
async function expectNoA11yViolations(container: Element): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  const bad = result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(bad.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe('Button', () => {
  it('defaults to type=button and is busy while loading', async () => {
    const onClick = vi.fn();
    const { rerender, container } = render(<Button onClick={onClick}>Kaydet</Button>);
    const btn = screen.getByRole('button', { name: 'Kaydet' });
    expect(btn).toHaveAttribute('type', 'button');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <Button loading onClick={onClick}>
        Kaydet
      </Button>,
    );
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await expectNoA11yViolations(container);
  });

  it('icon buttons carry an accessible name', () => {
    render(
      <IconButton label="Sil">
        <svg aria-hidden />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Sil' })).toBeInTheDocument();
  });
});

describe('Field', () => {
  it('wires label, hint and error to the control', async () => {
    const { container } = render(
      <Field label="E-posta" hint="İş adresiniz" error="Geçersiz adres">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('E-posta');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('İş adresiniz Geçersiz adres');
    await expectNoA11yViolations(container);
  });
});

describe('Dialog', () => {
  it('opens from the keyboard, traps focus, closes with Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Aç</Button>
        </DialogTrigger>
        <DialogContent title="Yeni görev" closeLabel="Kapat">
          <Input aria-label="Başlık" />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Aç' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Yeni görev' });
    expect(dialog).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
});

describe('DropdownMenu', () => {
  it('is operable with arrow keys and Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Menü</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Profil</DropdownMenuItem>
          <DropdownMenuItem onSelect={onSelect}>Çıkış</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    screen.getByRole('button', { name: 'Menü' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe('Select and Combobox', () => {
  it('Select shows the chosen label', () => {
    render(<Select aria-label="Öncelik" value="2" onValueChange={() => undefined} options={[{ value: '2', label: 'Orta' }]} />);
    expect(screen.getByRole('combobox', { name: 'Öncelik' })).toHaveTextContent('Orta');
  });

  it('Combobox filters and selects from the keyboard', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<string | null>(null);
      return (
        <>
          <Combobox
            aria-label="Atanan"
            value={v}
            onValueChange={setV}
            options={[
              { value: 'u1', label: 'Ayşe' },
              { value: 'u2', label: 'Mehmet' },
            ]}
            placeholder="Seçin"
            searchPlaceholder="Ara"
            emptyText="Yok"
          />
          <output data-testid="value">{v ?? ''}</output>
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Atanan' }));
    await user.keyboard('meh');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('u2');
    expect(screen.getByRole('combobox', { name: 'Atanan' })).toHaveTextContent('Mehmet');
  });
});

describe('Badges convey meaning without colour alone', () => {
  it('segment, status and priority badges render text and an icon', () => {
    const { container } = render(
      <>
        <SegmentBadge segment="b2c" label="Bireysel" />
        <StatusBadge category="closed" label="Tamamlandı" />
        <PriorityBadge priority={4} label="Acil" />
      </>,
    );
    expect(screen.getByText('Bireysel')).toBeInTheDocument();
    expect(screen.getByText('Tamamlandı')).toBeInTheDocument();
    expect(screen.getByText('Acil')).toBeInTheDocument();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3);
  });

  it('initials handle Turkish letters', () => {
    expect(initials('ismail öztürk')).toBe('İÖ');
    expect(initials('  ')).toBe('?');
  });
});

describe('Toast', () => {
  it('runs the undo action', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    function Harness() {
      const { toast } = useToast();
      return <Button onClick={() => toast({ title: 'Silindi', action: { label: 'Geri al', onAction: onUndo } })}>Sil</Button>;
    }
    render(
      <ToastProvider closeLabel="Kapat" regionLabel="Bildirimler">
        <Harness />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Sil' }));
    await user.click(await screen.findByRole('button', { name: 'Geri al' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });
});

describe('CommandDialog', () => {
  it('filters items and selects with Enter', async () => {
    const user = userEvent.setup();
    const onTasks = vi.fn();
    function Harness() {
      const [q, setQ] = useState('');
      return (
        <CommandDialog open onOpenChange={() => undefined} title="Komut paleti" placeholder="Ara" value={q} onValueChange={setQ}>
          <CommandGroup heading="Git">
            <CommandItem value="Görevler" onSelect={onTasks}>
              Görevler
            </CommandItem>
            <CommandItem value="Müşteriler" onSelect={() => undefined}>
              Müşteriler
            </CommandItem>
          </CommandGroup>
        </CommandDialog>
      );
    }
    render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Komut paleti' });
    await user.keyboard('gör');
    expect(screen.queryByText('Müşteriler')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onTasks).toHaveBeenCalledOnce();
    await expectNoA11yViolations(dialog);
  });
});
