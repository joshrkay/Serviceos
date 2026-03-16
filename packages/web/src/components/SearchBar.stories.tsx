import type { Meta, StoryObj } from '@storybook/react';
import { SearchBar } from './SearchBar';

const meta: Meta<typeof SearchBar> = {
  title: 'Core/SearchBar',
  component: SearchBar,
};
export default meta;

type Story = StoryObj<typeof SearchBar>;

export const Default: Story = {
  args: { onSearch: () => {} },
};

export const CustomPlaceholder: Story = {
  args: {
    placeholder: 'Search by name, email, or phone...',
    onSearch: () => {},
  },
};
