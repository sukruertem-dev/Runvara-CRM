import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { DatePicker } from './date-picker';
import { Checkbox, Combobox, SegmentedControl, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from './form-controls';
import { Field, Input, Textarea } from './input';
import { RichTextEditor, type RichTextValue } from './rich-text';

const meta: Meta = { title: 'Temel/Form' };
export default meta;
type Story = StoryObj;

const PEOPLE = [
  { value: 'u1', label: 'Ayşe Yılmaz' },
  { value: 'u2', label: 'Mehmet Demir' },
  { value: 'u3', label: 'Zeynep Kaya' },
];

export const Fields: Story = {
  render: function Render() {
    return (
      <div className="grid max-w-md gap-4">
        <Field label="Başlık" hint="En fazla 500 karakter.">
          <Input placeholder="Görev başlığı" />
        </Field>
        <Field label="E-posta" error="Geçerli bir e-posta adresi girin.">
          <Input type="email" defaultValue="ayse@" />
        </Field>
        <Field label="Not">
          <Textarea placeholder="Kısa not" />
        </Field>
      </div>
    );
  },
};

export const Selects: Story = {
  render: function Render() {
    const [priority, setPriority] = useState('2');
    const [owner, setOwner] = useState<string | null>('u2');
    const [due, setDue] = useState<string | null>('2026-11-24');
    return (
      <div className="grid max-w-md gap-4">
        <Field label="Öncelik">
          <Select
            value={priority}
            onValueChange={setPriority}
            options={[
              { value: '0', label: 'Yok' },
              { value: '1', label: 'Düşük' },
              { value: '2', label: 'Orta' },
              { value: '3', label: 'Yüksek' },
              { value: '4', label: 'Acil' },
            ]}
          />
        </Field>
        <Field label="Atanan">
          <Combobox value={owner} onValueChange={setOwner} options={PEOPLE} placeholder="Kişi seçin" searchPlaceholder="Ara…" emptyText="Sonuç yok" />
        </Field>
        <Field label="Bitiş tarihi">
          <DatePicker value={due} onChange={setDue} placeholder="Tarih seçin" clearLabel="Tarihi temizle" />
        </Field>
      </div>
    );
  },
};

export const Toggles: Story = {
  render: function Render() {
    const [on, setOn] = useState(true);
    return (
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox defaultChecked /> Alt görevleri göster
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked="indeterminate" /> Kısmen seçili
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={on} onCheckedChange={setOn} /> E-posta bildirimi
        </label>
      </div>
    );
  },
};

export const TabsStory: Story = {
  name: 'Tabs',
  render: () => (
    <Tabs defaultValue="list">
      <TabsList label="Görünüm">
        <TabsTrigger value="list">Liste</TabsTrigger>
        <TabsTrigger value="board">Kanban</TabsTrigger>
        <TabsTrigger value="table">Tablo</TabsTrigger>
      </TabsList>
      <TabsContent value="list" className="py-4 text-sm">
        Liste görünümü
      </TabsContent>
      <TabsContent value="board" className="py-4 text-sm">
        Kanban görünümü
      </TabsContent>
      <TabsContent value="table" className="py-4 text-sm">
        Tablo görünümü
      </TabsContent>
    </Tabs>
  ),
};

export const RichText: Story = {
  render: function Render() {
    const [value, setValue] = useState<RichTextValue | null>(null);
    return (
      <div className="grid max-w-xl gap-2">
        <RichTextEditor
          aria-label="Açıklama"
          value={value?.doc ?? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Müşteriyle ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'sözleşme' }, { type: 'text', text: ' detaylarını konuş.' }] }] }}
          onChange={setValue}
          placeholder="Açıklama ekleyin…"
          labels={{ toolbar: 'Biçimlendirme', bold: 'Kalın', italic: 'İtalik', heading: 'Başlık', bulletList: 'Madde listesi', orderedList: 'Numaralı liste', quote: 'Alıntı', code: 'Kod' }}
        />
        <p className="text-xs text-fg-muted">Düz metin: {value?.text ?? '—'}</p>
      </div>
    );
  },
};

export const Segmented: Story = {
  render: function Render() {
    const [view, setView] = useState<'list' | 'board' | 'table'>('list');
    return (
      <SegmentedControl
        label="Görünüm"
        value={view}
        onValueChange={setView}
        options={[
          { value: 'list', label: 'Liste' },
          { value: 'board', label: 'Kanban' },
          { value: 'table', label: 'Tablo' },
        ]}
      />
    );
  },
};
