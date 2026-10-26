"use client";

import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { DEFAULT_LIVENESS, MAX_CLAIM_BYTES, MAX_LIVENESS, MAX_U128, MIN_BOND_MUSD, MIN_LIVENESS } from "@muo/core/native";
import { Button } from "@muo/utils/ui/button";

import { useAppConfig } from "@/components/providers/app-providers";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroupTextUnit, Textarea } from "@/components/ui/input";
import { useCreateAssertion } from "@/hooks/use-assertion";
import { claimToHex, identifierForClaim, utf8Length } from "@/lib/claim";
import { reportOutcome } from "@/lib/tx-toast";

const BOND_RE = /^(0|[1-9][0-9]*)$/;
const MAX_BOND_TEXT = MAX_U128.toString();

/** Validates a whole-MUSD bond as a canonical decimal string, never a float. */
export const validateBondMusd = (value: string): string | null => {
  const text = value.trim();
  if (text === "") return "Enter a bond amount";
  if (!BOND_RE.test(text)) return "Enter a whole number of MUSD";
  if (text.length > MAX_BOND_TEXT.length) return `The bond cannot exceed ${MAX_BOND_TEXT} MUSD`;
  const amount = BigInt(text);
  if (amount < MIN_BOND_MUSD) return `Minimum bond is ${MIN_BOND_MUSD.toString()} MUSD`;
  if (amount > MAX_U128) return `The bond cannot exceed ${MAX_BOND_TEXT} MUSD`;
  return null;
};

export const assertSchema = z.object({
  claim: z
    .string()
    .refine((v) => v.trim().length > 0, { error: "Enter a claim" })
    .refine((v) => utf8Length(v) <= MAX_CLAIM_BYTES, { error: `Maximum length is ${MAX_CLAIM_BYTES.toLocaleString()} bytes` }),
  bondMusd: z.string().superRefine((v, ctx) => {
    const message = validateBondMusd(v);
    if (message) ctx.addIssue({ code: "custom", message });
  }),
  // The form control emits text, so validate text. An empty value means "use the protocol default".
  liveness: z.string().superRefine((v, ctx) => {
    const text = v.trim();
    if (text === "") return;
    if (!BOND_RE.test(text)) {
      ctx.addIssue({ code: "custom", message: "Enter a whole number of blocks" });
      return;
    }
    const blocks = BigInt(text);
    if (blocks < BigInt(MIN_LIVENESS)) ctx.addIssue({ code: "custom", message: `Minimum liveness is ${MIN_LIVENESS} block` });
    else if (blocks > BigInt(MAX_LIVENESS)) ctx.addIssue({ code: "custom", message: `Maximum liveness is ${MAX_LIVENESS.toLocaleString()} blocks` });
  }),
});

export type AssertFormValues = z.infer<typeof assertSchema>;
type Props = { open: boolean; onOpenChange: (open: boolean) => void; defaultValues?: Partial<AssertFormValues> };

export const ASSERT_RESOLVER = zodResolver(assertSchema);
export const ASSERT_DEFAULTS: AssertFormValues = { claim: "", bondMusd: MIN_BOND_MUSD.toString(), liveness: "" };
export const NUMERIC_FIELDS = [
  ["bondMusd", "Bond", "MUSD", MIN_BOND_MUSD.toString(), MIN_BOND_MUSD.toString()],
  ["liveness", "Liveness", "blocks", String(MIN_LIVENESS), `${DEFAULT_LIVENESS} (default)`],
] as const;

export function AssertDialog({ open, onOpenChange, defaultValues = ASSERT_DEFAULTS }: Props) {
  const uid = useId();
  const { config } = useAppConfig();
  const form = useForm<AssertFormValues>({ resolver: ASSERT_RESOLVER, defaultValues, reValidateMode: "onBlur" });
  const createAssertion = useCreateAssertion();
  const blocked = config === null;

  async function handleSubmit({ claim, bondMusd, liveness }: AssertFormValues) {
    const claimHex = claimToHex(claim);
    const identifier = identifierForClaim(claim);
    // Empty liveness means "use the protocol default"; the contract treats 0 that way.
    const livenessBlocks = liveness.trim() === "" ? null : Number(liveness.trim());
    const outcome = await createAssertion.mutate({ identifier, claim: claimHex, bondMusd, liveness: livenessBlocks });
    if (reportOutcome(outcome)) {
      form.reset(ASSERT_DEFAULTS);
      onOpenChange(false);
    }
  }

  const wrapField = (name: keyof AssertFormValues, label: string, input: (f: Record<string, unknown>, id: string, invalid: boolean) => ReactNode) => (
    <Controller
      key={name}
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`${uid}-${name}`}>{label}</FieldLabel>
          {input(field as unknown as Record<string, unknown>, `${uid}-${name}`, fieldState.invalid)}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset(ASSERT_DEFAULTS);
          // Clear a terminal failed/confirmed phase, otherwise the submit button stays
          // disabled on reopen and the user cannot retry without a page reload.
          createAssertion.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Assertion</DialogTitle>
        </DialogHeader>
        {blocked && (
          <p role="alert" className="text-destructive text-sm">
            The portal is not configured for a Mezo network. Assertions are disabled until the public environment is fixed.
          </p>
        )}
        <form onSubmit={form.handleSubmit(handleSubmit)}>
          <FieldGroup className="gap-5">
            {wrapField("claim", "Claim", (f, id, invalid) => (
              <Textarea {...f} id={id} rows={3} aria-invalid={invalid} className="max-h-48" />
            ))}
            <div className="grid grid-cols-2 gap-4">
              {NUMERIC_FIELDS.map(([name, label, unit, min, placeholder]) =>
                wrapField(name, label, (f, id, invalid) => (
                  <InputGroupTextUnit
                    {...(f as { value: string | null; onChange: (v: string | null) => void; onBlur: () => void })}
                    name={name}
                    id={id}
                    unit={unit}
                    min={min}
                    placeholder={placeholder}
                    aria-invalid={invalid}
                    inputMode="numeric"
                  />
                ))
              )}
            </div>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={(createAssertion.state.phase !== null && createAssertion.state.phase !== "confirmed") || blocked}>
              {createAssertion.state.phase === "approving" || createAssertion.state.phase === "awaiting-approval"
                ? "Approving MUSD ..."
                : createAssertion.state.phase === "writing" || createAssertion.state.phase === "awaiting-receipt"
                  ? "Submitting ..."
                  : "Assert"}
            </Button>
          </DialogFooter>
        </form>
        {createAssertion.state.error && (
          <p role="alert" className="text-destructive text-sm">
            {createAssertion.state.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
