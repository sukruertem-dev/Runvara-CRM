import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Heading2, Italic, List, ListOrdered, Quote } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cn, focusRing } from '../lib/cn';

export interface RichTextValue {
  doc: { type: 'doc'; content?: unknown[] };
  text: string;
}

export interface RichTextLabels {
  toolbar: string;
  bold: string;
  italic: string;
  heading: string;
  bulletList: string;
  orderedList: string;
  quote: string;
  code: string;
}

/**
 * ProseMirror editor (Tiptap StarterKit). Stores the JSON document and its plain text, the shape the API keeps
 * (`description` + `descriptionText`). Raw HTML is never accepted or rendered.
 */
export function RichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  labels,
  editable = true,
  className,
  'aria-label': ariaLabel,
}: {
  value: RichTextValue['doc'] | null;
  onChange?: (value: RichTextValue) => void;
  onBlur?: (value: RichTextValue) => void;
  placeholder: string;
  labels: RichTextLabels;
  editable?: boolean;
  className?: string;
  'aria-label': string;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] } }), Placeholder.configure({ placeholder })],
    content: (value as JSONContent | null) ?? '',
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: { 'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true', class: 'px-3 py-2' },
    },
    onUpdate: ({ editor: e }) => onChange?.({ doc: e.getJSON() as RichTextValue['doc'], text: e.getText() }),
    onBlur: ({ editor: e }) => onBlur?.({ doc: e.getJSON() as RichTextValue['doc'], text: e.getText() }),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // External value changes (another user's edit arrived) replace the content when the editor is not focused.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = JSON.stringify(value ?? null);
    if (next !== JSON.stringify(editor.isEmpty ? null : editor.getJSON())) editor.commands.setContent((value as JSONContent | null) ?? '', { emitUpdate: false });
  }, [editor, value]);

  const tool = (label: string, icon: ReactNode, active: boolean, run: () => void): ReactNode => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={run}
      className={cn('inline-flex size-7 items-center justify-center rounded-input text-fg-muted hover:bg-subtle hover:text-fg aria-pressed:bg-subtle aria-pressed:text-fg', focusRing)}
    >
      {icon}
    </button>
  );

  return (
    <div className={cn('fx-prose rounded-input border border-line-strong bg-surface text-sm text-fg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent', className)}>
      {editable && editor ? (
        <div role="toolbar" aria-label={labels.toolbar} className="flex flex-wrap gap-0.5 border-b border-line px-1.5 py-1">
          {tool(labels.bold, <Bold aria-hidden size={15} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {tool(labels.italic, <Italic aria-hidden size={15} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
          {tool(labels.heading, <Heading2 aria-hidden size={15} />, editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          {tool(labels.bulletList, <List aria-hidden size={15} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {tool(labels.orderedList, <ListOrdered aria-hidden size={15} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
          {tool(labels.quote, <Quote aria-hidden size={15} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
          {tool(labels.code, <Code aria-hidden size={15} />, editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
