import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const calls = [], replies = [];
const context = { URL, URLSearchParams, AbortController, TextDecoder, Intl, Date, setTimeout, clearTimeout,
  fetch: async (url, options) => { calls.push({ url, options, at: Date.now() }); return replies.shift()(url, options); },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("../app/src/main/assets/modules/routing.js", import.meta.url), "utf8"), context);
const routing = context.SloiRouting;
const from = [30.32, 59.85], to = [30.335, 59.934];
const road = { code: "Ok", routes: [{ duration: 600, distance: 1400, geometry: { type: "LineString", coordinates: [from, to] }, legs: [] }] };
const transit = { success: true, result: [{ sumTime: 1200, sumDistance: 5000, numTransfers: 0, stages: [
  { type: "walk", time: 120, distance: 100, path: [{ longitude: 30.32, latitude: 59.85 }, { longitude: 30.321, latitude: 59.851 }] },
  { type: "bus", routeNumber: "26", time: 1080, distance: 4900, stops: [
    { stopName: "Начальная", stopLongitude: 30.321, stopLatitude: 59.851 },
    { stopName: "Конечная", stopLongitude: 30.335, stopLatitude: 59.934 }],
    path: [{ longitude: 30.321, latitude: 59.851 }, { longitude: 30.335, latitude: 59.934 }] },
] }] };
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const plain = value => JSON.parse(JSON.stringify(value));

assert.deepEqual(plain(routing.listProviders()), [{ id: "osrm", modes: ["walk", "bicycle"] }, { id: "spb-transit", modes: ["transit"] }]);
replies.push(() => json(road));
const walked = await routing.plan({ from, to, mode: "walk" });
assert.ok(calls[0].url.includes("/routed-foot/route/v1/foot/30.32,59.85;30.335,59.934"));
assert.equal(new URL(calls[0].url).searchParams.get("alternatives"), "true");
assert.equal(walked[0].mode, "walk");
assert.equal(walked[0].legs[0].label, "Пешком");
assert.deepEqual(plain(walked[0].geometry.coordinates[0]), from);
assert.ok(walked[0].attribution.some(item => item.url.includes("fixthemap")));
replies.push(() => json(road));
const biked = await routing.plan({ from, to, mode: "bicycle" });
assert.ok(calls[1].url.includes("/routed-bike/route/v1/bike/"));
assert.ok(calls[1].at - calls[0].at >= 1000, "Public routing service must not be hammered on a mode switch");
assert.equal(biked[0].legs[0].label, "На велосипеде");

replies.push(() => json(transit));
const travelled = await routing.plan({ from, to, mode: "transit" });
const transitUrl = new URL(calls.at(-1).url);
assert.equal(transitUrl.pathname, "/transit-api-otp/routes");
assert.equal(transitUrl.searchParams.get("fromLat"), "59.85");
assert.equal(transitUrl.searchParams.get("fromLon"), "30.32");
assert.equal(transitUrl.searchParams.get("transports"), "bus,tram,trolley,subway");
assert.ok(transitUrl.searchParams.get("startTime").endsWith("+03:00"));
assert.equal(travelled[0].legs[1].label, "Автобус 26");
assert.equal(travelled[0].duration, 1200);
assert.equal(travelled[0].geometry.type, "MultiLineString");
assert.deepEqual(plain(travelled[0].geometry.coordinates[1][0]), [30.321, 59.851], "Longitude and latitude must not be reversed");
assert.equal(travelled[0].legs[1].stops[0].name, "Начальная");
assert.equal(travelled[0].transfers, 0);
assert.equal(routing.petersburgTime(new Date("2026-11-16T23:30:00Z")), "2026-11-17T02:30:00+03:00");

const direct = plain(transit.result[0]);
direct.endTime = "2026-11-17T10:20:00+03:00";
direct.startTime = "2026-11-17T10:00:00+03:00";
const transfer = plain(direct);
// A lying/missing reported zero must not hide a real second boarding, even
// when both vehicles use the same public route number.
transfer.stages.push(plain(transfer.stages[1]));
transfer.numTransfers = 0;
const alternatives = { success: true, result: [transfer, transfer, transfer, transfer, transfer, direct] };
assert.equal(routing.normalizeTransit(alternatives).length, 5);
assert.equal(routing.normalizeTransit(alternatives)[0].transfers, 1);
const filtered = routing.normalizeTransit(alternatives, { directOnly: true });
assert.equal(filtered.length, 1, "Filter all supplied itineraries before the five-card display cap");
assert.equal(filtered[0].transfers, 0);
assert.equal(filtered[0].arrivalTime, Date.parse(direct.endTime));
const noCount = plain(transfer); delete noCount.numTransfers;
assert.throws(() => routing.normalizeTransit({ success: true, result: [noCount] }, { directOnly: true }), /нет маршрута без пересадок/);
const reportedChange = plain(direct); reportedChange.numTransfers = 1;
assert.throws(() => routing.normalizeTransit({ success: true, result: [reportedChange] }, { directOnly: true }), /нет маршрута без пересадок/);
const missingTimestamp = plain(direct); missingTimestamp.endTime = "2026-11-17T10:20:00";
assert.equal(routing.normalizeTransit({ success: true, result: [missingTimestamp] })[0].arrivalTime, Date.parse(direct.endTime), "Official portal timestamps use Petersburg time, never the device timezone");
delete missingTimestamp.startTime;
assert.equal(routing.normalizeTransit({ success: true, result: [missingTimestamp] })[0].arrivalTime, null, "Do not show an arrival without a real departure");
replies.push(() => json(alternatives));
const preferred = await routing.plan({ from, to, mode: "transit", preferences: { directOnly: true } });
assert.equal(preferred.length, 1);
assert.equal(preferred[0].transfers, 0);
assert.equal(new URL(calls.at(-1).url).searchParams.has("maxTransfers"), false, "The city wrapper does not expose generic OTP maxTransfers");
replies.push(() => json({ success: true, result: [transfer] }));
await assert.rejects(routing.plan({ from, to, mode: "transit", preferences: { directOnly: true } }), /нет маршрута без пересадок/);

// The official city client exposes a transports subset. Still validate every
// returned journey so a server ignoring the restriction cannot leak a vehicle.
const metro = plain(direct); metro.stages[1].type = "subway"; metro.stages[1].routeNumber = "2";
const trolley = plain(direct); trolley.stages[1].type = "trolleybus";
const unknown = plain(direct); unknown.stages[1].type = "future-vehicle";
const mixed = plain(direct); mixed.stages.push(plain(metro.stages[1]));
assert.equal(routing.normalizeTransit({ success: true, result: [unknown] }).length, 1, "Default all preserves unknown future server types");
assert.throws(() => routing.normalizeTransit({ success: true, result: [unknown] }, { transportTypes: ["bus"] }), /выбранными видами/);
assert.throws(() => routing.normalizeTransit({ success: true, result: [mixed] }, { transportTypes: ["bus"] }), /выбранными видами/, "Never remove a disallowed leg and present a broken partial journey");
assert.equal(routing.normalizeTransit({ success: true, result: [mixed] }, { transportTypes: ["bus", "subway"] })[0].legs.length, 3);
assert.throws(() => routing.normalizeTransit({ success: true, result: [mixed] }, { transportTypes: ["bus", "subway"], directOnly: true }), /выбранными видами.*без пересадок/);
const typeAlternatives = { success: true, result: [direct, direct, direct, direct, direct, metro] };
assert.equal(routing.normalizeTransit(typeAlternatives, { transportTypes: ["subway"] }).length, 1, "Type filtering precedes the display cap");
assert.equal(routing.normalizeTransit({ success: true, result: [trolley] }, { transportTypes: ["trolley"] })[0].legs[1].type, "trolley");
const subwayTransfer = plain(metro); subwayTransfer.stages.push({ ...plain(metro.stages[0]), type: "subwaytransfer" });
assert.equal(routing.normalizeTransit({ success: true, result: [subwayTransfer] }, { transportTypes: ["subway"], directOnly: true })[0].transfers, 0);
replies.push(() => json(typeAlternatives));
const metroOnly = await routing.plan({ from, to, mode: "transit", preferences: { transportTypes: ["subway"], directOnly: true } });
assert.equal(new URL(calls.at(-1).url).searchParams.get("transports"), "subway");
assert.equal(metroOnly.length, 1);
assert.equal(metroOnly[0].legs[1].type, "subway");
const beforeInvalidTypes = calls.length;
for (const transportTypes of [[], ["train"], "bus"]) {
  await assert.rejects(routing.plan({ from, to, mode: "transit", preferences: { transportTypes } }), /вид транспорта/);
}
assert.equal(calls.length, beforeInvalidTypes, "Empty/invalid types are rejected before network or GPS work");

const count = calls.length;
for (const request of [{ from: [NaN, 0], to, mode: "walk" }, { from, to: [181, 30], mode: "walk" }, { from, to, mode: "car" }]) {
  await assert.rejects(routing.plan(request));
}
assert.equal(calls.length, count);
const controller = new AbortController(); controller.abort();
await assert.rejects(routing.plan({ from, to, mode: "transit", signal: controller.signal }), { name: "AbortError" });
assert.equal(calls.length, count);
assert.throws(() => routing.normalizeTransit({ success: false, result: [] }), /не найдена/);
assert.throws(() => routing.normalizeTransit({ success: true, result: [{ ...transit.result[0], stages: [{ ...transit.result[0].stages[0], path: [{ longitude: 200, latitude: 10 }, { longitude: 30, latitude: 10 }] }] }] }), /геометрию/);
replies.push(() => new Response("", { status: 429 }));
await assert.rejects(routing.plan({ from, to, mode: "transit" }), /занят/);
replies.push(() => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }));
await assert.rejects(routing.plan({ from, to, mode: "transit" }), /слишком большой/);
replies.push(() => new Response("{"));
await assert.rejects(routing.plan({ from, to, mode: "transit" }), /повреждённый/);

const pending = new AbortController();
replies.push((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
const promise = routing.plan({ from, to, mode: "transit", signal: pending.signal });
await new Promise(resolve => setTimeout(resolve, 1)); pending.abort();
await assert.rejects(promise, { name: "AbortError" });
assert.throws(() => routing.registerProvider({ id: "osrm", modes: ["walk"], plan: () => [] }), /источник/);

console.log("Routing OK: transport subsets, whole-journey type/direct-only validation before display cap, aliases, real alternatives, timestamps, walk/bicycle endpoints, throttling, geometry order, cancellation and bounded errors");
