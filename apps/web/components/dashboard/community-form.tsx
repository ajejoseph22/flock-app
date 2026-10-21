"use client";

import { slugify } from "@flock/core/domain/slug";
import { useActionState, useState } from "react";
import { saveCommunityAction } from "@/app/dashboard/actions";
import { FormMessage } from "@/components/ui/form-message";
import { Field, Input, Textarea } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

export interface CommunityDefaults {
  name: string;
  slug: string;
  description: string;
  benefits: string[];
  supportContact: string | null;
  avatarUrl: string | null;
}

export function CommunityForm({ defaults, appUrl }: { defaults: CommunityDefaults | null; appUrl: string }) {
  const [state, formAction] = useActionState(saveCommunityAction, null);
  const editing = Boolean(defaults);
  const [slug, setSlug] = useState(defaults?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(editing);
  const host = appUrl.replace(/^https?:\/\//, "");

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field label="Community name" htmlFor="name">
        <Input
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          defaultValue={defaults?.name}
          placeholder="e.g. Morning Market Notes"
          onChange={(e) => {
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </Field>
      <Field
        label="Page address"
        htmlFor="slug"
        hint={editing ? "The address can't be changed after creation, so existing links keep working." : `${host}/join/${slug || "your-community"}`}
      >
        <Input
          id="slug"
          name="slug"
          required
          pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]"
          title="3–48 lowercase letters, numbers and hyphens"
          value={slug}
          readOnly={editing}
          disabled={editing}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
        />
      </Field>
      <Field label="Description" htmlFor="description" hint="What members get, in a sentence or two.">
        <Textarea id="description" name="description" maxLength={2000} defaultValue={defaults?.description} rows={4} />
      </Field>
      <Field label="Benefits" htmlFor="benefits" hint="One per line, up to 8. Shown as a checklist on your page.">
        <Textarea id="benefits" name="benefits" defaultValue={defaults?.benefits.join("\n")} rows={4} placeholder={"Daily analysis\nWeekly live Q&A"} />
      </Field>
      <Field label="Support contact" htmlFor="supportContact" hint="Shown to members, e.g. @yourhandle or an email.">
        <Input id="supportContact" name="supportContact" maxLength={200} defaultValue={defaults?.supportContact ?? ""} />
      </Field>
      <Field label="Avatar image URL (optional)" htmlFor="avatarUrl" hint="An https:// link to a square image.">
        <Input id="avatarUrl" name="avatarUrl" type="url" maxLength={500} defaultValue={defaults?.avatarUrl ?? ""} placeholder="https://" />
      </Field>
      <FormMessage state={state} />
      <div>
        <SubmitButton pendingText="Saving…">{editing ? "Save changes" : "Create community"}</SubmitButton>
      </div>
    </form>
  );
}
