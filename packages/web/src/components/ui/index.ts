/**
 * Fieldly design-system primitives.
 *
 * Token-driven, dependency-free building blocks (no cva/radix) that
 * replace hand-rolled Tailwind markup across the app so spacing, color,
 * focus, disabled, and error states stay consistent and themeable.
 *
 * Import from `@/components/ui` (or a relative path to this barrel)
 * rather than re-styling raw `<button>`/`<input>` elements.
 */
export { cn } from './utils';
export { Button } from './button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './button';
export { Spinner } from './spinner';
export type { SpinnerProps, SpinnerSize } from './spinner';
export { Input, Textarea, Select } from './input';
export type { InputProps, TextareaProps, SelectProps } from './input';
export { Field } from './field';
export type { FieldProps } from './field';
export {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from './card';
export type { CardProps } from './card';
export { Badge } from './badge';
export type { BadgeProps, BadgeVariant } from './badge';
export { Skeleton, SkeletonText } from './skeleton';
export type { SkeletonProps, SkeletonTextProps } from './skeleton';
