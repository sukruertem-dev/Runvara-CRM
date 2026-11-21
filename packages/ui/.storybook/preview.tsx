import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import { ToastProvider } from '../src/components/toast';
import { TooltipProvider } from '../src/components/overlay';
import './preview.css';

/** Theme and density come from the toolbar and are applied the same way the app applies them (data attributes). */
const withAppearance: Decorator = (Story, context) => {
  const theme = context.globals['theme'] === 'dark' ? 'dark' : 'light';
  const density = context.globals['density'] === 'compact' ? 'compact' : 'comfortable';
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    document.documentElement.dataset['density'] = density;
  }, [theme, density]);
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider closeLabel="Kapat" regionLabel="Bildirimler">
        <div className="bg-canvas p-6 text-fg">
          <Story />
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
};

const preview: Preview = {
  decorators: [withAppearance],
  globalTypes: {
    theme: {
      description: 'Tema',
      toolbar: { title: 'Tema', icon: 'contrast', items: [{ value: 'light', title: 'Açık' }, { value: 'dark', title: 'Koyu' }], dynamicTitle: true },
    },
    density: {
      description: 'Yoğunluk',
      toolbar: { title: 'Yoğunluk', icon: 'component', items: [{ value: 'comfortable', title: 'Rahat' }, { value: 'compact', title: 'Kompakt' }], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light', density: 'comfortable' },
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
};

export default preview;
