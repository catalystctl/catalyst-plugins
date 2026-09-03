/**
 * AI Assistant — self-contained UI primitives.
 *
 * Marketplace-installed plugins can only import the published SDK
 * (@catalyst/plugin-sdk/frontend), not the panel's internal plugin-ui barrel.
 * This plugin keeps its own copies of the few primitives it uses
 * (shadcn-style, matching the panel's design tokens).
 */
import React from 'react';
import { Loader2, Plus, RefreshCw, Trash2, Copy, Send } from 'lucide-react';

export const TEXT_MUTED = 'text-muted-foreground';
export const FONT_MONO = 'font-mono';

export const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

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
      className="flex h-9 w-full items-center rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      value={value || ''}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="">{placeholder ?? 'Select…'}</option>
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

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        props.className,
      )}
    />
  );
}

export function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' }) {
  const tones: Record<string, string> = {
    default: 'border-border bg-muted text-muted-foreground',
    ok: 'border-emerald-700/40 bg-emerald-950/40 text-emerald-300',
    warn: 'border-amber-700/40 bg-amber-950/40 text-amber-300',
    bad: 'border-red-700/40 bg-red-950/40 text-red-300',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border border-border bg-card p-4', className)}>{children}</div>;
}

export { Loader2, Plus, RefreshCw, Trash2, Copy, Send };
