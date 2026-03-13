import React, { useState } from 'react';

export interface SearchBarProps {
  placeholder?: string;
  onSearch: (query: string) => void;
  debounceMs?: number;
}

export function SearchBar({ placeholder = 'Search...', onSearch, debounceMs = 300 }: SearchBarProps) {
  const [value, setValue] = useState('');
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    if (timer) clearTimeout(timer);
    setTimer(setTimeout(() => onSearch(newValue), debounceMs));
  };

  return (
    <div className="search-bar">
      <input
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
      />
    </div>
  );
}
