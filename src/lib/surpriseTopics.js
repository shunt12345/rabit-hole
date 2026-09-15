// Candidate pool for the hero page's "Surprise me" spin — a fixed,
// hand-written list, not generated per spin. Same reasoning as
// lib/inputPlaceholders.js and lib/openerVariety.js: spinning has to be
// free and instant (the whole point is letting someone reroll past a few
// boring picks before committing), so it can't cost a real API call every
// time. Real generation only happens once someone actually hits "Dig In"
// on whatever they land on — that's the one action that counts as a
// search and costs anything.
//
// Deliberately wide-ranging across domains rather than skewed to any one
// audience — see the product discussion this came out of: the target
// user (curious people, including technical/creative professionals) is
// exactly the type who already enjoys a random Wikipedia-article click
// completely outside their own field, so there's no reason to narrow this
// to "tech" or "science" topics specifically.
const SURPRISE_TOPICS = [
  "Octopus Cognition",
  "The Library Of Alexandria",
  "Bioluminescence",
  "The Voynich Manuscript",
  "Sourdough Starters",
  "Tardigrades",
  "The Printing Press",
  "Synesthesia",
  "Coral Reef Collapse",
  "The Antikythera Mechanism",
  "Lucid Dreaming",
  "Viking Navigation",
  "Fermentation",
  "The Dancing Plague Of 1518",
  "Mycelium Networks",
  "The Byzantine Empire",
  "Placebo Effect",
  "Deep Sea Creatures",
  "The Silk Road",
  "Honeybee Waggle Dance",
  "Roman Concrete",
  "Cryptic Crosswords",
  "The Great Emu War",
  "Migratory Birds",
  "The Manhattan Project",
  "Ancient Egyptian Medicine",
  "Quantum Entanglement",
  "The Dutch Tulip Mania",
  "Whale Falls",
  "The Rosetta Stone",
  "Cognitive Dissonance",
  "Volcanic Lightning",
  "The Library Of Babel",
  "Feral Children",
  "Ancient Roman Plumbing",
  "The Bystander Effect",
  "Ghost Ships",
  "The Green Children Of Woolpit",
  "Underwater Waterfalls",
  "The Trojan War",
  "Circadian Rhythms",
  "The Dyatlov Pass Incident",
  "Medieval Guilds",
  "Bioluminescent Fungi",
  "The Cuban Missile Crisis",
  "Octopus Camouflage",
  "The Salem Witch Trials",
  "Radioactive Decay",
  "The Lost City Of Atlantis",
  "Symbiotic Relationships",
  "The Berlin Wall",
  "Extremophiles",
  "The Great Fire Of London",
  "Muscle Memory",
  "The Bermuda Triangle",
  "Fractal Geometry",
  "The Mongol Empire",
  "Sleep Paralysis",
  "The Aurora Borealis",
  "Ancient Greek Democracy",
  "Tectonic Plates",
  "The Dust Bowl",
  "Animal Migration",
  "The Enigma Machine",
  "Cave Paintings",
  "The Placebo Button",
  "Deep Time",
  "The Spanish Flu",
  "Bioluminescent Plankton",
  "The Terracotta Army",
  "Neuroplasticity",
  "The Chernobyl Disaster",
  "Ancient Mesopotamia",
  "Optical Illusions",
  "The Wright Brothers",
  "Carnivorous Plants",
  "The Fall Of Rome",
  "Muscle Atrophy In Space",
  "The Gutenberg Bible",
  "Animal Domestication",
  "The Cold War Space Race",
  "Geothermal Energy",
  "The Black Death",
  "Bird Migration Routes",
  "The French Revolution",
  "Deep Ocean Pressure",
  "The Renaissance",
  "Genetic Mutations",
  "The Underground Railroad",
  "Volcanic Ash Clouds",
  "Ancient Chinese Inventions",
  "The Northern Lights",
  "Parasitic Wasps",
  "The Fall Of Constantinople",
  "Slime Mold Intelligence",
];

const STORAGE_KEY = "hyfax-surprise-idx";

// Fails toward "always the first topic" if storage is unavailable — same
// posture as the other rotation helpers, a lost rotation is cosmetic.
export function nextSurpriseTopic() {
  let idx = 0;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    idx = Number.isFinite(stored) && stored >= 0 ? (stored + 1) % SURPRISE_TOPICS.length : 0;
    localStorage.setItem(STORAGE_KEY, String(idx));
  } catch (_) {
    idx = Math.floor(Math.random() * SURPRISE_TOPICS.length);
  }
  return SURPRISE_TOPICS[idx];
}
