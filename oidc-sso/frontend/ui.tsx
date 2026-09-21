/**
 * OIDC SSO plugin — self-contained UI primitives.
 *
 * Marketplace-installed plugins can only import the published SDK
 * (@catalyst/plugin-sdk/frontend), not the panel's internal UI barrel, so
 * this plugin keeps its own copies of the primitives it uses (shadcn-style,
 * matching the panel's design tokens). Icons come from lucide-react.
 */
import React from 'react';
import { Loader2, Plus, RefreshCw, Trash2, Link2, CheckCircle2, XCircle, KeyRound } from 'lucide-react';

export const TEXT_MUTED = 'text-muted-foreground';
export const FONT_MONO = 'font-mono';

export const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

// ── Button ──
type ButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive';
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
    destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  };
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />;
}

// ── Input ──
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

// ── Label ──
export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

// ── Select (native, dependency-free) ──
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
        'flex h-9 w-full items-center rounded-md border border-border bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
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

// ── Toggle (checkbox + label row) ──
export function Toggle({
  checked,
  onCheckedChange,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[var(--primary)]"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description ? <span className={cn('block text-xs', TEXT_MUTED)}>{description}</span> : null}
      </span>
    </label>
  );
}

// ── Card ──
export function Card({ title, description, children, actions }: { title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {description ? <p className={cn('mt-0.5 text-xs', TEXT_MUTED)}>{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

// ── Badge ──
export function Badge({ tone = 'default', children }: { tone?: 'default' | 'success' | 'warn' | 'danger'; children: React.ReactNode }) {
  const tones = {
    default: 'border-border bg-muted text-muted-foreground',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
    danger: 'border-red-500/40 bg-red-500/10 text-red-500',
  } as const;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

// ── Status line ──
export function StatusLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function SsoIcon({ className }: { className?: string }) {
  return <KeyRound className={cn('h-4 w-4', className)} aria-hidden="true" />;
}

export { Loader2, Plus, RefreshCw, Trash2, Link2, KeyRound };
