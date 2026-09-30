// Voice commands for a house with Home Assistant's demo devices, each with the answers a careful reader would give.
// Deterministic, so every run sends the same requests. The questions are the kind an assistant asks about a command before
// acting on it: what to do, in which room, to what kind of device, and whether it's for later.

export const DEVICES = [
  { id: "light.kitchen_lights", name: "kitchen lights", domain: "light", area: "Kitchen" },
  { id: "light.bed_light", name: "bed light", domain: "light", area: "Bedroom" },
  { id: "light.living_room_rgbww_lights", name: "living room lights", domain: "light", area: "Living Room" },
  { id: "cover.kitchen_window", name: "kitchen window", domain: "cover", area: "Kitchen" },
  { id: "cover.living_room_window", name: "living room window", domain: "cover", area: "Living Room" },
  { id: "fan.living_room_fan", name: "living room fan", domain: "fan", area: "Living Room" },
  { id: "fan.ceiling_fan", name: "ceiling fan", domain: "fan", area: "Bedroom" },
  { id: "media_player.bedroom", name: "bedroom speaker", domain: "media_player", area: "Bedroom" },
  { id: "media_player.kitchen", name: "kitchen speaker", domain: "media_player", area: "Kitchen" },
  { id: "switch.decorative_lights", name: "decorative lights", domain: "switch", area: "Living Room" },
  { id: "climate.ecobee", name: "thermostat", domain: "climate", area: "Living Room" },
];

export const QUESTIONS = {
  action: { type: "choice", instructions: "What does the person want done?", criteria: { turn_on: null, turn_off: null, toggle: null, get_state: "asking how something is, not changing it", none_of_these: "not a command for the house" } },
  area: { type: "choice", instructions: "Which room is it about?", criteria: { Kitchen: null, Bedroom: null, "Living Room": null, none_of_these: "no room, or a room the house doesn't have" } },
  domain: { type: "choice", instructions: "What kind of device is it about?", criteria: { light: null, cover: "a window, blind or shade", fan: null, media_player: "a speaker or TV", switch: "a plain on/off switch", climate: "heating or cooling", none_of_these: null } },
  later: { type: "noul", instructions: "Is it for later rather than right now (a time, a delay, or a condition)?" },
};

const ON = ["turn on the {d}", "switch on the {d}", "{d} on please", "can you turn on the {d}", "put the {d} on", "i need the {d} on", "open the {d}", "start the {d}"];
const OFF = ["turn off the {d}", "switch off the {d}", "{d} off", "kill the {d}", "shut the {d} off", "close the {d}", "stop the {d}", "please turn the {d} off"];
const TOGGLE = ["toggle the {d}", "flip the {d}", "switch the {d} over"];
const STATE = ["is the {d} on", "are the {d} still on", "what's the {d} doing", "did i leave the {d} on", "is the {d} open", "check the {d}"];
const LATER = [" in ten minutes", " at 7pm", " when i leave", " after sunset", " tomorrow morning", " in an hour"];
const OTHER = ["what's the weather like", "tell me a joke", "who won the game last night", "add milk to the shopping list", "how do you spell necessary", "thanks", "good night", "set a timer for pasta"];

// cover "on" is open and "off" is close; the templates above cover both wordings
const COVER = /^(open|close|toggle|flip|check|switch the \{d\} over|what's|is the \{d\} open|start|stop)/;
const verbFits = (t, d) => d.domain === "cover" ? COVER.test(t) && !/^(start|stop)/.test(t) : !/open|close/.test(t);

export function commands() {
  const out = [];
  let k = 0;
  for (const d of DEVICES) {
    for (const [list, action] of [[ON, "turn_on"], [OFF, "turn_off"], [TOGGLE, "toggle"], [STATE, "get_state"]]) {
      for (const t of list) {
        if (!verbFits(t, d)) continue;
        const later = action !== "get_state" && k++ % 4 === 0 ? LATER[k % LATER.length] : "";
        out.push({ command: t.replace("{d}", d.name) + later, labels: { action, area: d.area, domain: d.domain, later: !!later } });
      }
    }
  }
  for (const t of OTHER) out.push({ command: t, labels: { action: "none_of_these", area: "none_of_these", domain: "none_of_these", later: false } });
  return out;
}

/** The request Dopp sees: the command, and the house it's said in (the same for every request, so Tiny reads the command). */
export const stateOf = (c) => ({ command: c.command, house: "demo" });
