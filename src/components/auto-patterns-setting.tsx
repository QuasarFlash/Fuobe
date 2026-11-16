"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PublicSetting } from "@/components/connect-field";
import { AUTO_IMAGE, AUTO_TRIGGER_MAX, autoPatternsProblems, DEFAULT_AUTO_PATTERNS, DEFAULT_TRIGGER_MODELS, triggerModelIds } from "@/lib/auto-image";

/**
 * Settings → Auto image model: the prompts Auto starts on the models set for them (AutoTriggerModelsSetting), whose run
 * details name the line they matched, one per line. The owner's only, as every setting is. Saving checks each line;
 * Reset puts the built-in list back.
 */
export function AutoPatternsSetting({ setting, onSave, saving }: { setting: PublicSetting | undefined; onSave: (value: string) => void; saving: boolean }) {
  const saved = setting?.value ?? DEFAULT_AUTO_PATTERNS.join("\n");
  const [text, setText] = useState(saved);
  // A save (here, or Add a pattern on a run) changes what is saved: the box follows it.
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setText(saved);
  }
  const problems = autoPatternsProblems(text);
  const changed = text.trim() !== saved.trim();
  return (
    <div className="space-y-2">
      <Label htmlFor="setting-auto-patterns" className="text-[13px] font-medium">
        Prompts that go to the models below
      </Label>
      <textarea
        id="setting-auto-patterns"
        value={text}
        spellCheck={false}
        rows={10}
        onChange={(e) => setText(e.target.value)}
        className="block w-full resize-y rounded-xl border bg-background p-3 font-mono text-[12px] leading-relaxed"
      />
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        One per line. A word or phrase matches as a whole word (a space or a hyphen matches either); any other line is a regular expression. Case
        doesn&rsquo;t matter, and a line that starts with # is a note. Prompts about lettering, posters or logos still go to MOSS-Image first.
      </p>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-[12px] text-destructive">
          {problems.slice(0, 5).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!changed || problems.length > 0 || saving} onClick={() => onSave(text)}>
          Save
        </Button>
        <Button size="sm" variant="outline" disabled={saving || !setting?.isSet} onClick={() => onSave("")}>
          Reset to the built-in list
        </Button>
      </div>
    </div>
  );
}

/** The open text-to-image models switched on here (GET /api/models), Auto itself left out. */
function useT2iModels() {
  return useQuery({
    queryKey: ["models", "auto-trigger"],
    queryFn: async () => {
      const body = (await (await fetch("/api/models?kind=image&engine=open&op=t2i")).json()) as { items?: { id: string; name: string; hidden?: boolean }[] };
      return (body.items ?? []).filter((m) => m.id !== AUTO_IMAGE && !m.hidden);
    },
    staleTime: 60_000,
  });
}

/**
 * Settings → Auto image model: the models for prompts the list above matches, in order (autoTriggerModels). Auto plans
 * the first that is switched on and fits the GPU; when one fails, the next makes the run. Saved as model ids separated by
 * commas; Reset puts the built-in order back.
 */
export function AutoTriggerModelsSetting({ setting, onSave, saving }: { setting: PublicSetting | undefined; onSave: (value: string) => void; saving: boolean }) {
  const savedText = setting?.isSet ? setting.value : "";
  const saved = savedText.trim() ? triggerModelIds(savedText) : [...DEFAULT_TRIGGER_MODELS];
  const [list, setList] = useState<string[]>(saved);
  // A save changes what is saved: the list follows it.
  const [shown, setShown] = useState(saved.join(","));
  if (shown !== saved.join(",")) {
    setShown(saved.join(","));
    setList(saved);
  }
  const models = useT2iModels();
  const on = models.data ?? [];
  const nameOf = (id: string) => on.find((m) => m.id === id)?.name;
  const addable = on.filter((m) => !list.includes(m.id));
  const move = (i: number, by: -1 | 1) =>
    setList((l) => {
      const next = [...l];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  const changed = list.join(",") !== saved.join(",");
  return (
    <div className="space-y-2">
      <Label id="setting-auto-trigger-models" className="text-[13px] font-medium">
        Models for these prompts, in order
      </Label>
      <ol aria-labelledby="setting-auto-trigger-models" className="divide-y rounded-xl border bg-background">
        {list.map((id, i) => (
          <li key={id} data-trigger-model={id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
            <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">
              {nameOf(id) ?? id}
              {models.isSuccess && !nameOf(id) && <span className="ml-2 text-[12px] text-muted-foreground">Switched off: skipped</span>}
            </span>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${nameOf(id) ?? id} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${nameOf(id) ?? id} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${nameOf(id) ?? id}`} disabled={list.length === 1} onClick={() => setList((l) => l.filter((m) => m !== id))}>
              <X />
            </Button>
          </li>
        ))}
      </ol>
      <Select value="" onValueChange={(id) => setList((l) => (l.includes(id) ? l : [...l, id]))} disabled={!addable.length || list.length >= AUTO_TRIGGER_MAX}>
        <SelectTrigger aria-label="Add a model" className="w-full sm:w-auto sm:min-w-56">
          <SelectValue placeholder="Add a model" />
        </SelectTrigger>
        <SelectContent>
          {addable.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Auto starts on the first model that is switched on and fits the GPU. When one can&rsquo;t make the run, the next one makes it, each at most
        once. Up to {AUTO_TRIGGER_MAX} models.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={!changed || !list.length || saving} onClick={() => onSave(list.join(","))}>
          Save
        </Button>
        <Button size="sm" variant="outline" disabled={saving || !setting?.isSet} onClick={() => onSave("")}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}
