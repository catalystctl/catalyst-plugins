/**
 * CS 1.6 Admin — self-contained UI primitives.
 * Marketplace bundles inline everything (no panel-internal imports).
 */
import React from 'react';
import { Loader2 } from 'lucide-react';

export const TEXT_MUTED = 'text-muted-foreground';
export const FONT_MONO = 'font-mono';
export const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type ButtonVariant = 'default' | 'outline' | 'ghost' | 'danger';
export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'default' | 'sm' | 'xs' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap';
  const sizes = {
    default: 'h-9 px-4 py-2 text-sm',
    sm: 'h-7 rounded-md px-2.5 text-xs',
    xs: 'h-6 rounded px-2 text-[11px]',
  };
  const variants: Record<ButtonVariant, string> = {
    default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
    outline: 'border border-border bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    danger: 'border border-red-800/60 bg-red-950/40 text-red-300 hover:bg-red-900/40',
  };
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />;
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-lg border border-border bg-card p-4', className)}>{children}</div>;
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold mb-3">{children}</h3>;
}

export function Badge({
  tone = 'zinc',
  title,
  children,
}: {
  tone?: 'zinc' | 'green' | 'red' | 'amber' | 'blue' | 'purple';
  title?: string;
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    zinc: 'border-zinc-700/60 bg-zinc-800/60 text-zinc-300',
    green: 'border-emerald-700/50 bg-emerald-950/40 text-emerald-300',
    red: 'border-red-700/50 bg-red-950/40 text-red-300',
    amber: 'border-amber-700/50 bg-amber-950/40 text-amber-300',
    blue: 'border-sky-700/50 bg-sky-950/40 text-sky-300',
    purple: 'border-purple-700/50 bg-purple-950/40 text-purple-300',
  };
  return (
    <span title={title} className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50',
        props.className,
      )}
    />
  );
}

export function Select({
  value,
  onValueChange,
  placeholder,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      className={cn(
        'flex h-9 w-full items-center rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50',
        className,
      )}
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

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

export function StatsCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className={cn('text-xs font-medium uppercase tracking-wide', TEXT_MUTED)}>{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub ? <div className={cn('mt-0.5 text-xs', TEXT_MUTED)}>{sub}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} />;
}

export { Loader2 };
