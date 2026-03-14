import type { Preview } from '@storybook/react';

const preview: Preview = {
  parameters: {
    chromatic: {
      // Capture snapshots at mobile and tablet breakpoints in addition to default desktop
      modes: {
        mobile: { viewport: 'mobile' },
        tablet: { viewport: 'tablet' },
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    viewport: {
      viewports: {
        mobile: {
          name: 'Mobile (390px)',
          styles: { width: '390px', height: '844px' },
        },
        tablet: {
          name: 'Tablet (768px)',
          styles: { width: '768px', height: '1024px' },
        },
      },
    },
    design: {
      type: 'figma',
      // Global fallback — shows the Figma file for all stories.
      // Override per-story with ?node-id=XXXX-YYYY to link a specific frame.
      // To get a node id: right-click a frame in Figma → "Copy link to selection"
      url: 'https://www.figma.com/make/prZaqgtGkagNYeVutpTSgU/Service-business-OS-AI-base',
    },
  },
};

export default preview;
