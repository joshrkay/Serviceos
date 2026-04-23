import React from 'react';

interface PhotoBucketProps {
  category: 'before' | 'after';
}

export function PhotoBucket({ category }: PhotoBucketProps) {
  return (
    <div>
      <p>{category === 'before' ? 'Before photos' : 'After photos'}</p>
    </div>
  );
}
