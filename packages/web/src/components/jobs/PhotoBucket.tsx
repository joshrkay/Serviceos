import React from 'react';

export type PhotoCategory = 'before' | 'after';

interface PhotoBucketProps {
  category: PhotoCategory;
}

export const PhotoBucket = ({ category }: PhotoBucketProps) => {
  const label = category === 'before' ? 'Before photos' : 'After photos';

  return (
    <div>
      <p>{label}</p>
    </div>
  );
};
