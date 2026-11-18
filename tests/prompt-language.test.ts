import { describe, expect, it, vi } from "vitest";
import { needsEnglish } from "@/lib/prompt-language";
import { cleanEnglish, ENGLISH_SYSTEM, englishPrompt, takesEnglish } from "@/server/english-prompt";

describe("needsEnglish: is a prompt in another language", () => {
  it.each([
    ["Romanian, typed without accents", "camasa trebuie sa fie alba, nu albastru deschis ca acum"],
    ["Romanian, with accents", "Fă cămașa albă"],
    ["Spanish", "una mujer con vestido rojo en la playa al atardecer"],
    ["French", "une femme en robe rouge sur la plage"],
    ["German", "Eine Frau im roten Kleid am Strand"],
    ["Portuguese", "Uma mulher de vestido vermelho na praia"],
    ["Italian", "Una donna con un vestito rosso sulla spiaggia"],
    ["Dutch", "Een vrouw in een rode jurk op het strand"],
    ["Polish", "Kobieta w czerwonej sukience na plaży"],
    ["Turkish", "Plajda kırmızı elbiseli bir kadın"],
    ["Indonesian", "Seorang wanita dengan gaun merah di pantai"],
    ["Hindi", "समुद्र तट पर लाल पोशाक में एक महिला"],
    ["Russian", "Женщина в красном платье на пляже"],
    ["Japanese", "ビーチで赤いドレスを着た女性"],
    ["Chinese", "海滩上穿红裙的女人"],
    ["Arabic", "امرأة ترتدي فستانا أحمر على الشاطئ"],
    ["Korean", "해변에서 빨간 드레스를 입은 여자"],
  ])("%s", (_name, text) => {
    expect(needsEnglish(text)).toBe(true);
  });

  it.each([
    "A fashion model in an ivory silk gown on a marble terrace at golden hour, editorial photograph",
    "Seiko watch on a wrist, close up, 85mm",
    "make the shirt white",
    "A woman walking in La Paz at night",
    "Portrait of Dan, cinematic lighting",
    'A neon sign that says "Bună seara, prieteni" over a bar',
    "@mira in a red dress, Image 1 style",
    "Kendrick wearing Dior Homme, studio portrait",
    "<Picture 1> walks toward the camera",
    "cyberpunk alley, rain, neon, 35mm",
    "",
  ])("leaves English as it is: %s", (text) => {
    expect(needsEnglish(text)).toBe(false);
  });
});

describe("englishPrompt: the model gets the prompt in English", () => {
  const RO = "camasa trebuie sa fie alba, nu albastru deschis ca acum";

  it("asks the text helper once, as a translate task, and cleans the answer", async () => {
    const ask = vi.fn(async () => '"Make the shirt white."');
    expect(await englishPrompt(RO, "image", "edit", { ask })).toBe("Make the shirt white.");
    expect(ask).toHaveBeenCalledTimes(1);
    const [system, user, opts] = ask.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(system).toBe(ENGLISH_SYSTEM);
    expect(user).toBe(RO);
    expect(opts).toMatchObject({ task: "translate" });
    expect(opts.ollamaOnly).toBeUndefined();
  });

  it("an open-engine run asks no paid API", async () => {
    const ask = vi.fn(async () => "Make the shirt white.");
    await englishPrompt(RO, "image", "edit", { ask, open: true });
    expect((ask.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]).toMatchObject({ ollamaOnly: true });
  });

  it("asks nothing for English, or for words that are spoken, sung or written", async () => {
    const ask = vi.fn(async () => "x");
    expect(await englishPrompt("A woman in a red dress on a beach", "image", "t2i", { ask })).toBeNull();
    expect(await englishPrompt(RO, "audio", "tts", { ask })).toBeNull();
    expect(await englishPrompt(RO, "audio", "music", { ask })).toBeNull();
    expect(await englishPrompt(RO, "video", "avatar", { ask })).toBeNull();
    expect(await englishPrompt(RO, "text", "write", { ask })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps the words as typed when no helper answers, it fails, or it answers with more than a prompt", async () => {
    expect(await englishPrompt(RO, "image", "edit", { ask: async () => null })).toBeNull();
    expect(await englishPrompt(RO, "image", "edit", { ask: async () => Promise.reject(new Error("down")) })).toBeNull();
    expect(await englishPrompt(RO, "image", "edit", { ask: async () => "Sure! ".repeat(200) })).toBeNull();
  });

  it("covers picture, clip and 3D descriptions only", () => {
    for (const op of ["t2i", "edit", "inpaint", "t2v", "i2v", "ref2v", "extend"] as const) expect(takesEnglish(op.endsWith("v") || op === "extend" ? "video" : "image", op)).toBe(true);
    expect(takesEnglish("model3d", "text-to-3d")).toBe(true);
    expect(takesEnglish("audio", "sfx")).toBe(false);
    expect(takesEnglish("text", "translate")).toBe(false);
  });
});

describe("cleanEnglish", () => {
  it("takes off a label, a code fence and wrapping quotes", () => {
    expect(cleanEnglish("English prompt: Make the shirt white.", "x")).toBe("Make the shirt white.");
    expect(cleanEnglish("```\nMake the shirt white.\n```", "x")).toBe("Make the shirt white.");
    expect(cleanEnglish("“Make the shirt white.”", "x")).toBe("Make the shirt white.");
  });

  it("keeps quotes the prompt itself starts with", () => {
    expect(cleanEnglish('"Hola" written in neon', '"Hola" escrito en neón')).toBe('"Hola" written in neon');
  });

  it("gives nothing for a refusal, so the run keeps the words as typed", () => {
    for (const r of ["I'm sorry, but I can't help with that.", "I cannot translate this content.", "I can't assist with that request.", "Sorry, I am unable to do that.", "As an AI, I won't write that."]) expect(cleanEnglish(r, "x")).toBeNull();
    // An answer that only starts like one goes as typed too (the words were the person's anyway)...
    expect(cleanEnglish("Unfortunately rainy street, a man under an umbrella", "x")).toBeNull();
    // ...unless the person's own words start that way.
    expect(cleanEnglish("Sorry sign in neon over a bar", "Sorry sign in neon")).toBe("Sorry sign in neon over a bar");
  });

  it("gives nothing for an empty answer", () => {
    expect(cleanEnglish("   ", "x")).toBeNull();
    expect(cleanEnglish(null, "x")).toBeNull();
  });
});
