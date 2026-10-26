"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

const FieldGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="field-group" className={cn("flex w-full flex-col gap-7", className)} {...props} />
);

const Field = ({ className, ...props }: React.ComponentProps<"fieldset">) => (
  <fieldset
    data-slot="field"
    className={cn("group/field flex w-full min-w-0 flex-col gap-3 *:w-full data-[invalid=true]:text-destructive [&>.sr-only]:w-auto", className)}
    {...props}
  />
);

const FIELD_LABEL_CLS =
  "group/field-label peer/field-label flex w-fit select-none items-center gap-2 font-medium text-sm leading-snug peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border has-data-checked:border-primary/30 has-data-checked:bg-primary/5 *:data-[slot=field]:p-3 group-data-[disabled=true]/field:opacity-50 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10";
const FieldLabel = ({ className, htmlFor, children, ...props }: React.ComponentProps<"label"> & { htmlFor: string }) => (
  <label data-slot="field-label" htmlFor={htmlFor} className={cn(FIELD_LABEL_CLS, className)} {...props}>
    {children}
  </label>
);

function FieldError({ className, children, errors, ...props }: React.ComponentProps<"div"> & { errors?: Array<{ message?: string } | undefined> }) {
  const messages = [...new Set(errors?.flatMap((e) => (e?.message ? [e.message] : [])))];
  const content =
    children ??
    (messages.length === 0 ? null : messages.length === 1 ? (
      messages[0]
    ) : (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    ));
  return content ? (
    <div role="alert" data-slot="field-error" className={cn("font-normal text-destructive text-sm", className)} {...props}>
      {content}
    </div>
  ) : null;
}

export { Field, FieldError, FieldGroup, FieldLabel };
