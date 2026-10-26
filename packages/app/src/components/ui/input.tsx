"use client";

import type * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";

export type NumberInputProps = Omit<React.ComponentProps<"input">, "type" | "onChange" | "value"> & {
  onChange: (value: number | null) => void;
  value: undefined | null | number;
};

/** Text input that keeps the raw string, for exact decimal amounts that must not become floats. */
export type TextAmountInputProps = Omit<React.ComponentProps<"input">, "type" | "onChange" | "value"> & {
  onChange: (value: string | null) => void;
  value: undefined | null | string;
};

const INPUT_CLS =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";
const GROUP_CLS =
  "group/input-group relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs outline-none transition-[color,box-shadow] has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 dark:bg-input/30 dark:has-[[data-slot][aria-invalid=true]]:border-destructive/50 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40";

export function NumberInput({ className, onChange, value, ...props }: NumberInputProps) {
  return (
    <InputPrimitive
      type="number"
      data-slot="input"
      className={cn(INPUT_CLS, "h-9 py-1 disabled:pointer-events-none", className)}
      {...props}
      onChange={(e) => {
        const n = e.target.valueAsNumber;
        onChange(Number.isNaN(n) ? null : n);
      }}
      value={value ?? ""}
    />
  );
}

/**
 * Whole-amount text input.
 *
 * Uses `type="text"` with a numeric inputMode so arbitrarily large integers survive
 * intact -- `type="number"` would round them through a double.
 */
export function TextAmountInput({ className, onChange, value, ...props }: TextAmountInputProps) {
  return (
    <InputPrimitive
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      data-slot="input"
      className={cn(INPUT_CLS, "h-9 py-1 font-mono tabular-nums disabled:pointer-events-none", className)}
      {...props}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === "" ? null : raw);
      }}
      value={value ?? ""}
    />
  );
}

export function InputGroupNumberUnit({ unit, className, id, ...props }: NumberInputProps & { unit: string }) {
  return (
    <fieldset data-slot="input-group" className={GROUP_CLS}>
      <NumberInput
        id={id}
        data-slot="input-group-control"
        className={cn(
          "flex-1 rounded-none border-0 bg-transparent pr-1.5 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
          className
        )}
        {...props}
      />
      <label htmlFor={id} data-slot="input-group-addon" className="cursor-text pr-2 font-medium text-muted-foreground text-sm">
        {unit}
      </label>
    </fieldset>
  );
}

export function InputGroupTextUnit({ unit, className, id, ...props }: TextAmountInputProps & { unit: string }) {
  return (
    <fieldset data-slot="input-group" className={GROUP_CLS}>
      <TextAmountInput
        id={id}
        data-slot="input-group-control"
        className={cn(
          "flex-1 rounded-none border-0 bg-transparent pr-1.5 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
          className
        )}
        {...props}
      />
      <label htmlFor={id} data-slot="input-group-addon" className="cursor-text pr-2 font-medium text-muted-foreground text-sm">
        {unit}
      </label>
    </fieldset>
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(INPUT_CLS, "field-sizing-content flex min-h-16 py-2", className)} {...props} />;
}
