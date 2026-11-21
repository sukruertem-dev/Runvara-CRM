import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** tailwind-merge taught the token scale (text-xs…3xl, radius names) so conflicting classes resolve correctly. */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'],
      radius: ['input', 'btn', 'card', 'hero', 'full'],
      shadow: ['card', 'popover'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}

/** Shared focus ring (§10.5.2: 2 px accent + 2 px gap). */
export const focusRing = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
