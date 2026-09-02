/**
 * Auto FastDL — self-contained UI primitives.
 *
 * Marketplace-installed plugins can only import the published SDK
 * (@catalyst/plugin-sdk/frontend), not the panel's internal plugin-ui barrel.
 * To stay installable AND buildable standalone, this plugin keeps its own
 * copies of the few primitives it uses (shadcn-style, matching the panel's
 * design tokens). Icons come from lucide-react; the bundle inlines everything.
 */
import React from 'react';
import { Loader2, Plus, RefreshCw, Trash2, Copy } from 'lucide-react';

// ── Design tokens (mirrors catalyst-frontend/src/plugins/plugin-ui-constants) ──
export const TEXT_MUTED = 'text-muted-foreground';
export const FONT_MONO = 'font-mono';

export const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

// ── Button ──
type ButtonVariant = 'default' | 'outline' | 'ghost';
export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'default' | 'sm' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  const sizes = { default: 'h-9 px-4 py-2 text-sm', sm: 'h-7 rounded-md px-2.5 text-xs' };
  const variants: Record<ButtonVariant, string> = {
    default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
    outline: 'border border-border bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
  };
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />;
}

// ── Select (native, dependency-free) ──
export function Select({
  value,
  onValueChange,
  placeholder,
  children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  children: React.ReactNode;
}) {
  return (
    <select
      className="flex h-9 w-full items-center rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      value={value || ''}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="" disabled>
        {placeholder ?? 'Select…'}
      </option>
      {children}
    </select>
  );
}

export function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <option value={value} className="bg-popover text-popover-foreground">
      {children}
    </option>
  );
}
export const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const SelectTrigger = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const SelectValue = ({ children }: { children?: React.ReactNode }) => <>{children ?? null}</>;

// ── Skeleton ──
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

// ── StatsCard (mirrors panel component) ──
export function StatsCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className={cn('text-xs font-medium uppercase tracking-wide', TEXT_MUTED)}>{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

// ── Icon re-exports (panel barrel parity) ──
export { Loader2, Plus, RefreshCw, Trash2, Copy };
