import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";

/**
 * The lesson used by the public demo (PRD P9-03). It is written by hand in the same shape
 * the ingestion pipeline produces, so every layout can be tried without signing in or
 * calling a model, and so the demo keeps working with the network off. Its simpler
 * wordings are written out here too, for the same reason.
 */

export const SAMPLE_LESSON_ID = "demo-water-cycle";
export const SAMPLE_GRAPH_VERSION = 1;

const excerpt = (text: string) => text.slice(0, 400);

export const SAMPLE_LESSON: KnowledgeGraph = {
  schemaVersion: 1,
  lessonId: SAMPLE_LESSON_ID,
  title: "The Water Cycle",
  overview:
    "Water on Earth is always moving. It travels between the oceans, the air, and the land in a loop called the water cycle. This lesson follows one drop of water around the loop.",
  language: "en",
  sections: [
    { id: "s_rising", title: "Water rising", order: 0 },
    { id: "s_returning", title: "Water returning", order: 1 },
  ],
  concepts: [
    {
      id: "c_evaporation",
      sectionId: "s_rising",
      order: 0,
      title: "Evaporation",
      summary: "Heat from the sun turns liquid water into water vapor that rises into the air.",
      body: "The sun warms the water in oceans, lakes, and rivers. Some of that water turns into a gas called water vapor and rises into the air.\n\nThis change from liquid to gas is called evaporation. It happens faster when it is hot, dry, or windy.",
      keyTerm: "evaporation",
      definition: "Liquid water changing into a gas.",
      examples: ["A puddle on the pavement that disappears on a sunny afternoon."],
      prerequisites: [],
      visualHint: "The sun over an ocean with arrows rising from the water.",
      source: {
        kind: "offset",
        start: 0,
        excerpt: excerpt(
          "The sun warms the water in oceans, lakes, and rivers. Some of that water turns into a gas called water vapor and rises into the air.",
        ),
      },
      flags: [],
    },
    {
      id: "c_transpiration",
      sectionId: "s_rising",
      order: 1,
      title: "Transpiration",
      summary: "Plants also send water into the air through tiny openings in their leaves.",
      body: "Plants take water up through their roots. Most of it is not kept. It leaves through tiny openings in the leaves and joins the air as water vapor.\n\nThis is called transpiration. A large forest sends a great deal of water into the air this way.",
      keyTerm: "transpiration",
      definition: "Water leaving a plant through its leaves as vapor.",
      examples: ["A tree on a warm day, giving off water you cannot see."],
      prerequisites: ["c_evaporation"],
      visualHint: "A tree with arrows rising from its leaves.",
      source: {
        kind: "offset",
        start: 420,
        excerpt: excerpt(
          "Plants take water up through their roots. Most of it is not kept. It leaves through tiny openings in the leaves and joins the air as water vapor.",
        ),
      },
      flags: [],
    },
    {
      id: "c_condensation",
      sectionId: "s_rising",
      order: 2,
      title: "Condensation",
      summary: "Rising vapor cools and turns back into tiny droplets that gather as clouds.",
      body: "High in the sky the air is cold. When water vapor rises there, it cools and turns back into tiny drops of liquid water.\n\nThis is called condensation. Billions of these drops gather together and form clouds.",
      keyTerm: "condensation",
      definition: "Water vapor cooling into liquid droplets.",
      examples: ["The drops that form on the outside of a cold glass."],
      prerequisites: ["c_evaporation"],
      visualHint: "Vapor rising into a cloud made of small drops.",
      source: {
        kind: "offset",
        start: 860,
        excerpt: excerpt(
          "High in the sky the air is cold. When water vapor rises there, it cools and turns back into tiny drops of liquid water.",
        ),
      },
      flags: [],
    },
    {
      id: "c_precipitation",
      sectionId: "s_returning",
      order: 3,
      title: "Precipitation",
      summary: "When cloud droplets grow heavy they fall as rain, snow, sleet, or hail.",
      body: "Inside a cloud the tiny drops bump into each other and join together. When they become too heavy to stay up, they fall.\n\nWhat falls depends on the temperature:\n\n- Rain, when it is warm enough.\n- Snow, when it is cold.\n- Sleet or hail, in between.\n\nAll of these are called precipitation.",
      keyTerm: "precipitation",
      definition: "Water falling from clouds to the ground.",
      examples: ["Rain on a spring afternoon.", "Snow settling on a winter morning."],
      prerequisites: ["c_condensation"],
      visualHint: "A cloud with rain and snow falling beneath it.",
      source: {
        kind: "offset",
        start: 1250,
        excerpt: excerpt(
          "Inside a cloud the tiny drops bump into each other and join together. When they become too heavy to stay up, they fall.",
        ),
      },
      flags: [],
    },
    {
      id: "c_collection",
      sectionId: "s_returning",
      order: 4,
      title: "Collection",
      summary: "Fallen water runs into rivers, lakes, and oceans or soaks into the ground.",
      body: "Water that falls does not disappear. Some of it runs over the land and into streams, rivers, lakes, and finally the ocean. Some soaks into the ground and becomes groundwater.\n\nFrom there the sun warms it again, and the cycle begins once more.",
      keyTerm: "collection",
      definition: "Fallen water gathering in rivers, lakes, oceans, and underground.",
      examples: ["A stream carrying rainwater down a hill to a river."],
      prerequisites: ["c_precipitation"],
      visualHint: "Rivers flowing to the ocean, with water soaking into the ground.",
      source: {
        kind: "offset",
        start: 1740,
        excerpt: excerpt(
          "Water that falls does not disappear. Some of it runs over the land and into streams, rivers, lakes, and finally the ocean.",
        ),
      },
      flags: [],
    },
  ],
  quizItems: [
    {
      id: "q_evaporation_1",
      conceptId: "c_evaporation",
      type: "mcq",
      prompt: "What happens to water during evaporation?",
      options: [
        "It turns into a gas",
        "It turns into ice",
        "It falls as rain",
        "It sinks underground",
      ],
      answer: "It turns into a gas",
      acceptable: [],
      explanation: "Heat turns liquid water into water vapor, which is a gas.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_evaporation_2",
      conceptId: "c_evaporation",
      type: "true_false",
      prompt: "Evaporation happens faster when it is hot.",
      answer: "true",
      acceptable: [],
      explanation: "Heat gives water the energy to turn into vapor, so warmth speeds it up.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_transpiration_1",
      conceptId: "c_transpiration",
      type: "mcq",
      prompt: "Where does a plant's water leave through?",
      options: ["Its roots", "Tiny openings in its leaves", "Its flowers only", "Its bark"],
      answer: "Tiny openings in its leaves",
      acceptable: [],
      explanation: "Water leaves a plant as vapor through tiny openings in the leaves.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_transpiration_2",
      conceptId: "c_transpiration",
      type: "short_answer",
      prompt: "In one word, what is water leaving a plant through its leaves called?",
      answer: "transpiration",
      acceptable: ["transpiring"],
      explanation: "Water leaving a plant through its leaves is called transpiration.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_condensation_1",
      conceptId: "c_condensation",
      type: "mcq",
      prompt: "What forms when water vapor cools high in the sky?",
      options: ["Clouds", "Oceans", "Rivers"],
      answer: "Clouds",
      acceptable: [],
      explanation: "Cooled vapor condenses into tiny drops, and many drops together make a cloud.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_condensation_2",
      conceptId: "c_condensation",
      type: "true_false",
      prompt: "Condensation is water vapor turning into liquid.",
      answer: "true",
      acceptable: [],
      explanation: "Condensation is the change from a gas back into a liquid.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_precipitation_1",
      conceptId: "c_precipitation",
      type: "true_false",
      prompt: "Snow is a kind of precipitation.",
      answer: "true",
      acceptable: [],
      explanation: "Rain, snow, sleet, and hail are all precipitation.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_precipitation_2",
      conceptId: "c_precipitation",
      type: "mcq",
      prompt: "Why do the drops in a cloud fall?",
      options: [
        "They become too heavy to stay up",
        "The sun pulls them down",
        "They turn into vapor",
      ],
      answer: "They become too heavy to stay up",
      acceptable: [],
      explanation: "Tiny drops join together until they are too heavy to stay in the air.",
      difficulty: "apply",
      flags: [],
    },
    {
      id: "q_collection_1",
      conceptId: "c_collection",
      type: "mcq",
      prompt: "Where can fallen water end up?",
      options: ["In rivers and oceans", "Only in clouds", "Nowhere, it disappears"],
      answer: "In rivers and oceans",
      acceptable: [],
      explanation: "Water runs into rivers, lakes, and oceans, or soaks into the ground.",
      difficulty: "recall",
      flags: [],
    },
    {
      id: "q_collection_2",
      conceptId: "c_collection",
      type: "short_answer",
      prompt: "What do we call water that soaks into the ground?",
      answer: "groundwater",
      acceptable: ["ground water"],
      explanation: "Water that soaks into the ground is called groundwater.",
      difficulty: "apply",
      flags: [],
    },
  ],
};

/** Simpler wordings for the demo, written by hand. Keyed by concept, then by level. */
export const SAMPLE_VARIANTS: Record<string, { plain: string; simple: string }> = {
  c_evaporation: {
    plain:
      "The sun heats water in oceans, lakes, and rivers. Some of the water turns into a gas called water vapor. The vapor goes up into the air.\n\nThis is called evaporation. It happens faster on hot, dry, or windy days.",
    simple:
      "The sun makes water warm. The warm water turns into a gas. The gas goes up. This is evaporation.",
  },
  c_transpiration: {
    plain:
      "Plants drink water through their roots. They do not keep all of it. Some water goes out through tiny holes in the leaves and becomes vapor in the air.\n\nThis is called transpiration. A big forest puts a lot of water into the air.",
    simple:
      "Plants drink water. Some water goes out of the leaves into the air. This is transpiration.",
  },
  c_condensation: {
    plain:
      "The air is cold high in the sky. When water vapor goes up there, it gets cold and turns back into tiny drops of water.\n\nThis is called condensation. Many tiny drops come together and make a cloud.",
    simple:
      "High up, the air is cold. The vapor gets cold. It turns into tiny drops. The drops make a cloud. This is condensation.",
  },
  c_precipitation: {
    plain:
      "In a cloud, tiny drops join together and get bigger. When they are too heavy, they fall down.\n\nWhat falls depends on how cold it is:\n\n- Rain when it is warm.\n- Snow when it is cold.\n- Sleet or hail in between.\n\nAll of these are called precipitation.",
    simple:
      "Drops in a cloud get big and heavy. Then they fall. It can fall as rain or snow. This is precipitation.",
  },
  c_collection: {
    plain:
      "Water that falls does not go away. Some of it runs into streams, rivers, lakes, and the ocean. Some goes into the ground. This is called groundwater.\n\nThe sun warms the water again, and the cycle starts over.",
    simple:
      "The water that falls goes into rivers and the ocean. Some goes into the ground. Then the sun warms it and it starts again.",
  },
};
