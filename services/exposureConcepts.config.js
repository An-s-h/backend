/**
 * Generalizable exposure concept configuration.
 * Starts with mold / damp / mycotoxin exposure, but is designed to be extended.
 */

export const EXPOSURE_FAMILIES = [
  {
    id: "mold_toxicity",
    canonicalLabel: "mold toxicity",
    tokens: [
      "mold",
      "mould",
      "fungal",
      "fungus",
      "mycotoxin",
      "mycotoxins",
      "stachybotrys",
      "damp",
      "dampness",
      "indoor",
      "water-damaged",
      "building",
    ],
    phrases: [
      "mold toxicity",
      "mould toxicity",
      "mycotoxin exposure",
      "mycotoxin poisoning",
      "indoor mold",
      "indoor mould",
      "indoor dampness",
      "indoor damp",
      "indoor damp air",
      "water-damaged building",
      "water damaged building",
      "indoor damp environment",
    ],
    toxicityTokens: [
      "toxicity",
      "toxic",
      "poisoning",
      "exposure",
      "environmental exposure",
    ],
    protectedTokens: [
      "mold",
      "mould",
      "mycotoxin",
      "mycotoxins",
      "stachybotrys",
      "dampness",
      "water-damaged",
      "water damaged",
      "environmental exposure",
      "toxicity",
      "toxic",
      "poisoning",
      "exposure",
      "trigger",
    ],
  },
];

// Flattened protected token/phrase lists for quick checks in parsing/tokenization.
export const PROTECTED_EXPOSURE_TOKENS = new Set(
  EXPOSURE_FAMILIES.flatMap((f) => f.protectedTokens || []),
);

export const EXPOSURE_PHRASES = EXPOSURE_FAMILIES.flatMap(
  (f) => f.phrases || [],
);

