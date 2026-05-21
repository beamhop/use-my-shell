/**
 * Room code generation and shareable URL construction.
 *
 * Room codes are word-list triplets (`brave-otter-lake`) — readable enough to
 * say aloud, with enough entropy from a ~256-word list to resist guessing
 * (256^3 ≈ 16.7M combinations). The format matches `isValidRoomCode` in the
 * shared protocol package.
 */

import { randomInt } from "node:crypto";

// A compact, unambiguous word list. All lowercase, alphabetic only — required
// by the protocol's ROOM_CODE_RE. Kept intentionally small but >= 256 entries
// for entropy.
const WORDS = [
  "amber", "anchor", "apple", "arrow", "aspen", "atlas", "autumn", "azure",
  "bamboo", "basil", "beacon", "berry", "birch", "bishop", "blossom", "bolt",
  "branch", "brave", "breeze", "bridge", "bright", "brook", "buffalo", "cabin",
  "cactus", "canyon", "cedar", "chalk", "cherry", "clay", "clever", "cliff",
  "cloud", "clover", "comet", "copper", "coral", "cosmic", "cotton", "crane",
  "crescent", "crimson", "crystal", "dahlia", "daisy", "dawn", "delta", "desert",
  "diamond", "dolphin", "dove", "dragon", "dune", "eagle", "echo", "ember",
  "emerald", "ember", "evening", "fable", "falcon", "feather", "fennel", "fern",
  "fjord", "flame", "flint", "forest", "fox", "frost", "galaxy", "garnet",
  "gentle", "ginger", "glacier", "gold", "granite", "grove", "harbor", "hawk",
  "hazel", "heron", "hickory", "hollow", "honey", "horizon", "ivory", "jade",
  "jasmine", "jasper", "juniper", "kestrel", "lagoon", "lake", "lantern", "lark",
  "laurel", "lemon", "lily", "linen", "lotus", "lunar", "lupine", "lynx",
  "magnet", "maple", "marble", "marsh", "meadow", "mellow", "merit", "mesa",
  "metro", "mint", "misty", "morning", "moss", "mountain", "narwhal", "nebula",
  "nectar", "nettle", "noble", "nomad", "north", "oak", "oasis", "ocean",
  "olive", "onyx", "opal", "orbit", "orchid", "osprey", "otter", "owl",
  "panda", "pearl", "pebble", "pepper", "petal", "phoenix", "pine", "pioneer",
  "piper", "plum", "polar", "pollen", "poppy", "prairie", "prism", "puma",
  "quartz", "quiet", "quill", "rabbit", "radiant", "rain", "raven", "reef",
  "ridge", "river", "robin", "rocket", "rowan", "ruby", "rune", "saffron",
  "sage", "salmon", "sand", "sapphire", "scarlet", "shadow", "shell", "shore",
  "silver", "sky", "slate", "sleet", "snow", "solar", "sparrow", "spruce",
  "starling", "stone", "storm", "stream", "summer", "summit", "sunny", "swan",
  "swift", "sycamore", "tango", "teal", "tempo", "thicket", "thistle", "thunder",
  "tide", "timber", "topaz", "torch", "tower", "tulip", "tundra", "twilight",
  "valley", "velvet", "vesper", "violet", "vista", "volcano", "walnut", "warbler",
  "water", "waterfall", "wave", "willow", "winter", "wisp", "wolf", "wonder",
  "yarrow", "yonder", "zephyr", "zenith", "almond", "antler", "arbor", "badger",
  "blaze", "boulder", "carbon", "cinder", "clarity", "cobalt", "current", "dapple",
  "drift", "ferry", "flicker", "glimmer", "harvest", "indigo", "kindle", "lullaby",
  "meridian", "murmur", "nimbus", "oracle", "pebble", "quiver", "ripple", "solace",
  "tinder", "umber", "vapor", "whistle", "yearling", "zircon", "anvil", "beacon",
];

const WORD_COUNT = WORDS.length;

function pickWord(): string {
  // randomInt is uniform and cryptographically strong.
  return WORDS[randomInt(WORD_COUNT)] as string;
}

/** Generate a `word-word-word` room code. */
export function makeRoomCode(): string {
  return `${pickWord()}-${pickWord()}-${pickWord()}`;
}

/**
 * Build the browser URL for a room. The room code goes in the query string;
 * the password (if any) is never placed in the URL — the host shares it
 * out-of-band and the browser prompts for it.
 */
export function makeShareUrl(webUrl: string, roomCode: string): string {
  const base = webUrl.replace(/\/+$/, "");
  return `${base}/?r=${encodeURIComponent(roomCode)}`;
}
