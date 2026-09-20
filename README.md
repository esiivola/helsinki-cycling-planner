# Helsinki cycling planner

Point-to-point cycling routes for the Helsinki region, computed **entirely in the
browser**. No routing server: the page downloads a contracted road graph once
(~8.7 MB gzipped) and answers every query locally in tens of milliseconds.

It does not optimise for distance. It minimises *perceived* time — what the ride
actually costs a person:

| | cost |
|---|---|
| riding | distance ÷ your speed |
| traffic light | 30 s per wait; a wide street crossed in two goes is two |
| turn at a junction | 10 s right, 15 s left |
| unsignalised crossing | 2 s |
| unpaved, or shared with pedestrians | ridden at 0.65 × speed |

A bend where a street merely changes name or curves is **not** a turn: turns are
counted only where three or more ways meet, because only there did the rider have
to decide anything.

## Why the search is edge-based

The cost of arriving somewhere depends on where you arrived *from* — that is what a
turn penalty means. A search over nodes cannot express it, so it can only count
turns after the fact, on a route that never tried to avoid them. This router's
state is a **directed edge**, so the bend between consecutive edges is priced
inside the search. On real routes that cuts turns hard while *saving* perceived
time, priced the same way for both: Vuosaari → Central Station drops from 79 turns
to 43 (71.2 min to 66.6), Munkkiniemi → Ruoholahti from 23 to 18 (28.2 to 27.4), at
18 km/h on the committed graph.

## What a turn is worth

A turn is not only the speed you scrub rebuilding it. It is also a thing you have to
remember: a route that stays on one street is one instruction, and a route that
zigzags is twenty. `scripts/bench_turns.mjs` sweeps the penalty over the benchmark
pairs and re-prices every result on one common scale, so the settings can be compared
without each being judged by the rule that produced it.

| turn penalty | turns/km | left turns | waits | re-priced at 10 s a turn |
|---|---|---|---|---|
| 0 s | 4.57 | 410 | 58 | 1134 min |
| 10 s, symmetric | 2.69 | 255 | 82 | 1086 min |
| 15 s, symmetric | 2.34 | 229 | 81 | 1083 min |
| 45 s, symmetric | 1.48 | 142 | 182 | 1125 min |
| **10 s, left ×1.5** | **2.52** | **231** | **75** | **1079 min** |

Simply raising the penalty does not pay. Past ~12 s the search starts dodging turns
onto through-roads that carry lights, the waits climb faster than the manoeuvres
fall, and the ride gets worse on its own terms. What pays is charging the two
directions differently: a right turn crosses nothing — the Dutch GPS study found
right-turning cyclists largely do not stop at all — while a left crosses the opposing
traffic, which in Finland usually means taking it in two goes. At 1.5× the left, the
benchmark loses 6% of its manoeuvres and 9% of its left turns at the lowest measured
cost of anything swept.

It moves a real boundary, which `test_build_graph.py` and `route.test.ts` now pin
from both sides: a bypass of two *right* turns costs 20 s and is still worth taking
to dodge a 30 s light, while the same bypass made of two *left* turns costs 30 s and
is not. The shared constants still match the housing map's cycling layer; the
left-turn factor is an addition to this router rather than a divergence, because a
model that counts turns after routing cannot tell the two apart.

## Riding the signposted network

Helsinki's prioritised cycle network — the baanas — is already in the extract, as
`route=bicycle` relations: 598 km of the region's 22,211 rideable kilometres, with
Pohjoisbaana, Viikinbaana and Pitäjänmäenbaana in it by name. No second dataset and
no second licence, and it is maintained by the same people who map everything else
here.

Those edges cost the search 0.9 of what an ordinary way costs. Swept like everything
else:

| network bonus | ridden on the network | true time |
|---|---|---|
| none | 39.8% | 1108 min |
| 0.95 | 44.1% | 1102 min |
| **0.90** | **48.9%** | **1101 min** |
| 0.85 | 53.8% | 1111 min |
| 0.80 | 57.7% | 1120 min |

At 0.9 the routes ride half their distance on the signposted network and get *faster*
in real terms, because a baana is where the through-route with the fewest turns and
lights already was — the discount mostly finds time the search was leaving on the
table. Push it further and it starts buying signposting with minutes. As with every
other penalty here, the discount applies to the search only: the minutes reported are
summed from true costs.

## Which side of the kerb

A cycleway mapped beside a road is a separate way, so a router that treats both as
rideable will send you down the carriageway: same direction, same corner, wrong side
of the kerb. `scripts/bench_riding.mjs` measures it over the ten benchmark pairs,
and it was not a corner case — **37% of every routed kilometre was carriageway with
a cycleway running beside it**, over half on some pairs.

| | on a cycleway | on a carriageway beside one | total time |
|---|---|---|---|
| before | 37% | 37% (81 km of 218) | 943 min |
| tags only (`bicycle=use_sidepath`) | 71% | 0.3% | 1,044 min |
| tags and geometry | 76% | 0.1% | 1,062 min |

Riding legally costs 13% more time. That is the real price of the route, not a
regression.

Two signals say a carriageway's cycle traffic belongs beside it. The explicit one is
`bicycle=use_sidepath`, which covers 19,745 ways and 1,774 km of the region — and
which the builder used to ignore entirely. The tags are not the whole story though:
Helsinginkatu carries cycle tracks its carriageway never mentions, which is why the
reported Olympiastadion → Brahenkenttä ride went down the road. So the geometry is
asked directly as well — is there a cycleway within 20 m, running within 30° of the
same heading, along at least 70% of this edge? That finds 21,663 roads the tags miss,
and a cycleway merely *crossing* a road is excluded by the heading test rather than
closing the road it crosses.

The carriageway is then priced at eight times its cost rather than removed. That is
not squeamishness: forbidding it outright made four of the ten benchmark routes fail
to connect at all, and a route that cannot be found falls back to the road for its
whole length, which is worse than riding 20 m of it where a cycleway is not mapped
through. The route is *reported* at its true cost, so the minutes on screen are still
minutes.

## Which lights are yours

A traffic signal is a node, and the cost model charges it only where it sits on the
way being ridden. That is exact where the tagging is, and silent where it is not:
**52% of the region's signals (3,751 of 7,225) sit on a carriageway and on no
cycleway at all**, so a rider on the path beside it met none of them and the junction
was priced as free.

Proximity alone cannot fix that, because a signal 15 m from a cycleway may be facing
the cars, not the rider — and only 311 signals in the whole region carry
`traffic_signals:direction` to say so. The geometry answers it instead: a rider is
charged for a signal within 25 m only where **their own path cuts across the road the
signal stands on** by at least 45°, which is the case where they have to wait for it.
Of 1,514 cycle crossings with a road signal in reach:

| | |
|---|---|
| given the light — the rider crosses the road it governs | 551 |
| spared — the rider rides *beside* it, so it faces the cars | 514 |
| spared — the same junction is already counted within 30 m | 449 |

## One wait per carriageway

Crossing Mannerheimintie is not one wait. It is two carriageways with an island
between them, and the rider waits on the island for the second half — one set of
lights, two stops. The model used to charge it once, because "two crossing nodes a
few metres apart are one junction" is true of the junction and false of the wait.

The tags cannot carry this on their own. Only 459 of the region's 7,225 signalised
crossings (6%) say `crossing:island=yes`, and only 169 stand on a road tagged with
four lanes or more — Mannerheimintie and Hämeentie are in neither list, because each
carriageway is tagged separately with two lanes of its own. Reaching for a list of
big streets by name would work in Helsinki and nowhere else.

So the rule is the one the geometry already states: **a rider waits once per
carriageway they cross**. A dual road *is* two crossing nodes, so the fix is simply
to stop merging them — the merge now asks which carriageways meet each node and
suppresses a second wait only when both nodes cross the same one, which is the same
road tagged twice rather than a road with a middle. Where a cycleway meets
Mannerheimintie the graph now carries 58 signalled crossings, 42 of them paired
within 30 m and charged as two waits; Hämeentie has 18 such pairs, Mechelininkatu 19.
A crossing tagged `crossing:island=yes` gets the second wait directly, since the
island is the statement that it is crossed in two goes.

Region-wide that is 7,581 waits where there were 7,051: 412 from islands, 118 from
carriageways that had been merged away. `scripts/bench_signals.mjs` reports waits
against stops, and the benchmark routes now wait 83 times at 81 stops over 220 km —
41 minutes, 4% of the riding. The count in the panel is *waits*, not lights, which is
why it is labelled that way.

Charging it properly also changes what the router picks: the benchmark routes now
meet 83 waits rather than the 96 they met when every crossing cost one, for 0.6% more
distance. Avoiding a big junction is worth a detour that avoiding half of one is not.

That last merge rule matters because a carriageway tagged twice is still one wait.
Over the benchmark pairs the routes meet 96 lights rather than the 66 they found
before signals were attached to the crossings they govern — 0.44 per km rather than
0.30 — and the ride from Olympiastadion to Brahenkenttä, which is 1.6 km of
Helsinginkatu, counts seven.

The remaining gap is deliberate: where a cycleway crosses a side street at a
signalised junction whose signal node sits on the main road, the headings agree and
no light is charged. Catching that needs the junction's whole geometry, not one
node's, and charging it wrongly invents stops that never happen.

### The cities' own signal registers

OSM is the only source for everything else here; for signals it is not enough.
Audited against Helsinki's register, 481 of 506 in-service signalised junctions (95%)
had *some* signal in the graph within 40 m, but only 465 (92%) had one a rider would
meet — and of the 41 that did not, 23 have an OSM signal nearby, **none of it on a
cycleway**, while 18 are absent from OSM altogether. So about half the gap is tagging
the geometry rule cannot reach and half is data that is simply not there.

`tools/fetch_signals.py` pulls all three registers into `tools/signals.json` — 930
signalised junctions, Helsinki 506, Espoo 261, Vantaa 163, CC BY 4.0 — and the build
reads it. A junction the graph already knows about is left alone; one it does not
gets its light on the nearest node where the rider's own way meets a carriageway, or
one already tagged as a crossing, within 40 m. Nowhere else: the register gives one
point for a whole junction, and putting that on the nearest node of any kind would
drop lights on street corners.

Where the light goes matters as much as whether it is added. At a big junction the
cycleway and the carriageway often **share no node at all** — that is precisely why
these junctions were orphans — so a light hung on the road is met by nobody on the
path beside it. Each kind of way therefore gets its own: the nearest at-grade node of
the cycleway, and the nearest of the carriageway. A rider passes one of them, never
both.

Two things never get a light. A bridge or a tunnel, because a rider passing *under* a
signalised junction passes no signal and the register — one point for a whole
junction — cannot tell you which it is. And, at the ordinary 40 m reach, nothing: a
motorway interchange is signalised at its ramps and its register point sits in the
middle of the whole thing, so a junction that finds nothing inside 40 m gets a second
look out to 80 m. 34 junctions needed that, and the build names every one. Past 80 m
the nearest path stops being one that passes the junction at all, and a light there
would be a wait that never happens.

The build ends with a census, so there is no such thing as a silent orphan:

```
register: 166 lights added, 1,653 already known, 34 beyond 40 m, 0 junctions no rider reaches
```

`tools/audit_signals.py` checks the built graph back against the registers, and asks
the harder question — not whether a light is near the junction but whether it is one
a *rider* meets, since a signal on a carriageway the router avoids is met by nobody:

| | junctions | within 40 m | within 80 m |
|---|---|---|---|
| Helsinki | 506 | 99.0% | 99.8% |
| Espoo | 261 | 98.1% | 100% |
| Vantaa | 163 | 97.5% | 100% |
| all | 930 | **98.5%** | **99.9%** |

Before the registers were read at all, that figure was 91.9% for Helsinki.

### Whose light is it

A light beside a cycleway is not automatically a light the rider obeys. Of the
region's 7,219 signals, **2,686 are `highway=traffic_signals` standing on a
carriageway and on nothing else**: they face the drivers. Where a cycleway runs
parallel to that road, as a sidepath does for most of its length, the rider passes
them and never stops. OSM draws the same line — `highway=traffic_signals` is a
junction's signal, `crossing=traffic_signals` is a crossing's — and 4,175 of the
region's signals carry the crossing form.

| signal | lies on | count |
|---|---|---|
| `highway=traffic_signals` | road only | 2 686 |
| `crossing=traffic_signals` | cycleway and road | 2 291 |
| `crossing=traffic_signals` | road only | 871 |
| `crossing=traffic_signals` | cycleway only | 405 |
| `highway=traffic_signals` | cycleway and road | 46 |

Direction tags cannot settle it: 272 nodes carry `traffic_signals=signal` and 310 a
direction, against 7,219 signals. So the test is geometric, and the same one in both
places a light can be attached: the rider is charged only where their own way **cuts
across** the carriageway by 45° or more, or where somebody has tagged the node a
crossing, which says it in words. A path running alongside is left alone.

The rule was already applied to signals OSM tags. It was *not* applied to the ones
taken from the city registers, whose docstring claimed it and whose code took the
nearest cycleway node — so on a sidepath the light landed on a node the rider rides
straight past. Both now use the same test, and the road's heading is read from the
carriageways around the junction rather than from the candidate node, because at a
big junction the cycleway and the carriageway often share no node at all — which is
the case the register exists to rescue.

It corrects few lights here (the registers are junctions by construction, where
riders do cross) and it is a guard against the case that is badly wrong rather than a
mass correction.

### Snapping a register point to a rider, by riding distance

The registers give one point for a whole junction, and the first version attached it
to the nearest place a rider passes within 40 m. That is wrong wherever a route
crosses a road without meeting it. The Baana runs in a former railway cutting beneath
every street it crosses and has no traffic light on it at all; it was given one,
which cost 30 s on the one corridor in the city whose whole point is that you never
stop.

Tags cannot see this. The Baana is not a tunnel and carries no `layer`, because it is
the *street overhead* that is the bridge — the vertical relationship is recorded on
the other way, so a filter reading the cycleway's own tags is structurally blind to
it. The terrain model cannot see it either, which is worth recording because it looks
as though it should: MML's korkeusmalli is a ground model with bridge decks removed,
so the street above the Baana and the Baana beneath it both read 13,5 m.

What does see it is **riding distance**. A signalised junction is a place you ride
*through*, so the test is whether a rider can get there from the junction without
leaving it. On the Baana the phantom sat 42 m away in plan view and 333 m away to
ride, because reaching the street means climbing a ramp and coming back. The register
point now anchors to the nearest carriageway node, a bounded search finds everything
within `REGISTER_WALK_M` of riding, and only those nodes can take the light.

The threshold is the honest part. A first pass at 110 m looked clean: over the
junctions that had both a road and a cycleway node close by, 95% connected within
57 m and the rest jumped straight past 300 m. That sample was biased — it excluded
the awkward junctions by construction. Checking what actually lost a light found
genuine at-grade crossings at 106, 164, 175 and 200 m: a Finnish suburban crossroads
often joins its cycleway well back from the corner. The populations do separate, but
by less than the first measurement suggested, so the line is drawn at 240 m, above
the honest cases and below the 284 m ramp and the 333 m Baana.

It is set to keep lights rather than to catch every false one. A light wrongly kept
costs a rider 30 s of pessimism; a light wrongly dropped makes a route that stops look
like one that does not.

Against the registers the cost is 1,9 points of coverage — 98,5% of junctions had a
light a rider meets within 40 m, now 96,6%. Of the 18 that changed, seven are named
in the registers as motorway ramps (Turunväylä, Lahdenväylä, Lentoasemantie,
Tuusulanväylä), where a rider on the path alongside passes under and meets nothing:
those are the fix working. Eight are Espoo entries, which the city publishes without
names. Three are ordinary crossings and are losses.

### Why there is no green wave in the model

The obvious upgrade to a flat 30 s is to know the junction: its cycle time, its green
split, whether it is coordinated with its neighbours into a green wave. All three
cities publish their signals as open data under CC BY — [Helsinki][hkisig],
[Espoo][esposig] and [Vantaa][vansig] — and none of it carries timing. The Helsinki
layer's fields are `id`, `numero`, `tyyppi`, `risteys`, `lisatiedot`, `datanomistaja`
and `paivitetty_tietopalveluun`: where the signal is, what kind it is, which junction
it belongs to. Espoo publishes "sijainti pistemäisenä paikkatietoaineistona" and
Vantaa "liikennevaloliittymien sijainnit". Locations, not phases.

So a green wave cannot be modelled from open data today, and the flat 30 s stands
until it can. What the datasets *are* good for is the other half of the problem: they
are the authoritative answer to which junctions are signalised at all, against the
OSM tagging this graph reads, and merging them would fix signals OSM has not got yet.
That is a worthwhile upgrade, and it is about *which* junctions, not what they cost.

Helsinki also runs BePolite signals in the centre, which cut a cyclist's wait rather
than the timing being published; there is no dataset of where they are.

[hkisig]: https://hri.fi/data/dataset/helsingin-liikenne-ja-varoitusvaloliittymat
[esposig]: https://hri.fi/data/dataset/espoon-liikennevaloliittymat
[vansig]: https://hri.fi/data/dataset/vantaan-liikennevaloliittymat

### What other routers charge for a light

Worth checking the 30 s against what else is out there, because it is the single
biggest non-riding term in the model.

| router | what a traffic light costs a cyclist | ≈ seconds at 18 km/h |
|---|---|---|
| [OSRM][osrm] `bicycle.lua` | `traffic_signal_penalty = 2`, added to the turn duration | 2 s |
| [BRouter][brouter] `trekking.brf` | `initialcost 20` at a signal, in *equivalent metres* | ~4 s |
| BRouter community profiles ([FFMbyBicycle][ffm], Fastbike) | 99–120 equivalent metres | ~20–24 s |
| [GraphHopper][gh] | no default signal penalty for bike; reachable only through a custom turn-cost model | 0 s |
| [Valhalla][valhalla] | signals are detected for the narrative; the documented bike penalties are gates, tolls and manoeuvres | ~0 s |
| this router | 30 s per wait, twice at a crossing made in two stages | 30 / 60 s |

The equivalent-metre profiles are not strictly convertible — BRouter optimises a cost
that is not time — so those rows are indicative.

Against measurement rather than against each other: a Dutch study of GPS traces at 18
signalised intersections found a **median bicycle delay of 34 s and a mean of 70 s**,
with per-intersection medians from 19.8 s to 48.1 s, and cites earlier empirical
medians of 16–57 s ([Gholamialam et al.][dutch], *Sensors* 2023). Webster's delay
term, C(1−g)²/2, gives 20–30 s at the 90–120 s cycles and ~0.3 green share a Helsinki
cyclist meets, which is where this model's 30 s came from.

So the popular open routers charge a cyclist between nothing and ~24 s for a light
that measurement puts at a median of 34 s, and the mean is twice the median because
some waits are long — which is the same asymmetry the two-stage rule prices. 30 s per
wait sits at the median; 60 s for a staged crossing sits near the mean. That is the
calibration this model is willing to defend, not a claim that the others are wrong
for their purposes: a router that reports distance and a rough duration can afford to
ignore a light, and one whose whole output *is* the perceived duration cannot.

[osrm]: https://github.com/Project-OSRM/osrm-backend/blob/master/profiles/bicycle.lua
[brouter]: https://github.com/abrensch/brouter/blob/master/misc/profiles2/trekking.brf
[ffm]: https://github.com/FFMbyBicycle/brouter-cycling-profiles/blob/master/FFMbyBicycle-long-distance-cycling.brf
[gh]: https://github.com/graphhopper/graphhopper/blob/master/docs/core/custom-models.md
[valhalla]: https://valhalla.github.io/valhalla/api/route/api-reference/
[dutch]: https://pmc.ncbi.nlm.nih.gov/articles/PMC10747837/

## One-way streets

Edges carry which way round they may be ridden, and the search only ever expands a
directed edge it is allowed to ride, so a route never proposes going against a
no-entry sign. 8.3% of the region's rideable ways are one-way for a bicycle
(20,634 of 249,199) — mostly arterials mapped as two carriageways, plus 1,093
one-way cycleways — so ignoring direction is not a rounding error.

What counts as one-way for a *bicycle* is not what `oneway=yes` says on its own.
A Helsinki one-way street commonly carries a contraflow cycle lane, tagged either
`oneway:bicycle=no` or in the older style `cycleway=opposite_lane`; either makes the
street two-way for this router. A roundabout is one-way whether or not anyone tagged
it. A contracted edge is rideable in a direction only if every segment in it is: one
one-way block closes the whole edge that way.

Direction also changed what "connected" means. The graph is restricted to its
largest **strongly** connected component: a cul-de-sac you can only reach by riding
the wrong way up a one-way street is not reachable at all, and keeping it would let
a query snap onto a node it can never leave.

## How much traffic

"I would rather not ride with cars" was one switch for a long time, and it could only
ask whether a way was built for bicycles. In this region that puts a cul-de-sac and a
four-lane arterial in the same bucket, and there are plenty of both. Version 7 carries
a class per edge instead — none, calm, moderate, busy, arterial — taken from the road's
`highway` tag, which stands in for how many cars there are and how fast they go closely
enough here, and unlike `maxspeed` is tagged on nearly every way.

| class | share of the network |
|---|---|
| none — cycleway, path, footway | 48,0 % |
| calm — residential, service, living street | 37,8 % |
| moderate — unclassified, tertiary | 9,3 % |
| busy — secondary | 3,5 % |
| arterial — primary | 1,4 % |

The aversion is then scaled by the class rather than applied flat, so avoiding traffic
reaches for a residential street long before it reaches for the long way round one.
Each edge takes the class carrying most of its metres, the same rule the street name
already followed: 20 m of service road crossing a residential street does not make the
whole edge a service road.

## Gravel, or a crowd

The old `edge_slow` said a stretch was slow without saying why, and the two reasons
want opposite things. Someone on 25 mm tyres wants the shared promenade; someone who
has had enough of walking pace wants the gravel track. Version 7 splits the metres in
two — `edge_unpaved` and `edge_shared` — and keeps them **disjoint**: a gravel path
full of walkers counts once, as unpaved. Disjoint is what lets the two still add up to
the metres ridden at the slow-surface factor, so the speed model is untouched by the
split and nobody's estimate moved.

The benchmark shows the trade plainly. Avoiding shared paths hard cuts them from 40 %
of the ride to 5 %, and pushes gravel *up* from 10,5 % to 35 %: the rider is being sent
off the promenades and onto the tracks. Past ×4 it starts escaping onto sidepath
carriageways instead, which is the same ceiling the old combined row had and the same
reason to stop there.

One thing to know if you touch the builder: length, unpaved and shared are each rounded
to the decimetre on their own, so the two parts can exceed the whole by exactly one.
316 of 424 987 edges do. The decoder clamps the sum, because a negative fast remainder
is both untrue and enough to break the promise A* runs on — that no edge ever costs
less than riding it.

## What a hill is worth

The region is flatter than most, which made it worth asking whether elevation changes
any route here at all before paying to carry it. Sampling a terrain model along the
routes the planner already returns said yes, and by more than expected: **every
benchmark pair's alternatives differ in climb**, by 17 to 85 m, and six of the ten
have a genuinely flatter option than the one chosen. A 10 km commute gains 75-126 m;
the 42 km Kauklahti-Vuosaari run gains about 380 m.

What the alternatives cost varies enough that this has to be a preference rather than
a fixed rule. Leppävaara to Kauniainen saves 14 m of climb for three minutes over the
same 6,1 km, which is a bargain. Helsinki centre to Kauniainen saves 52 m for fourteen
minutes and 2,6 km, which is not. A rider should get to say which they would take.

Climbing is charged as **riding**, not as a delay: a hill is time in the saddle, and
filing it under "pysähtely ja käännökset" would present it as friction the rider could
avoid by not stopping. A descent pays back the climb charged on the same edge and no
further — freewheeling through a city does not beat flat, because the junctions, the
braking and the lights take the gift back, and a negative cost would make A*'s
heuristic optimistic for the sake of a fiction.

### Drawing the ride, not just totalling it

A total of 92 m says nothing about whether that is one wall or spread over ten
kilometres, so the panel draws the profile. Three things had to be right for the
chart and the number beside it to tell the same story.

Heights are carried at every **shape point**, not only at junctions. A junction-only
profile cannot see what the road does between junctions, and on the benchmark routes
that lost a third to two fifths of the climb — a chart visibly gaining 56 m under a
headline of 92.

They are stored as **one byte each**, zigzag deltas from the point before, anchored to
each edge's own start node. Absolute heights cost 1.9 MB gzipped; deltas cost 0.6 MB
for the same data, because adjacent points are 20 m apart and the ground between them
rarely moves a metre. 78 of 899,848 deltas are too large for a byte — bridges and
tunnels, where the model steps — and are clamped; the next junction snaps the chain
back to truth, so a clamp cannot drift beyond the edge it is on.

And the drawn line is **smoothed over 100 m**, because the terrain model's noise at
20 m spacing sums to 155 % of the real climb and draws as a sawtooth. Smoothed, the
chart's own gain lands at 77–87 % of the reported figure, which is close enough that
the two do not appear to disagree. The line is then thinned to one point per pixel,
keeping the highest and lowest in each column so a summit is never averaged away.

### Carried beside the graph, not inside it

The graph already holds the full shape of all 424,926 edges, so climb can be sampled
against the graph that is already built — no OSM extract, no rebuild, no version bump.
`tools/build_climb.py` walks every edge, samples the terrain under it, and writes
`climb.bin.gz`: two `uint16` per edge, ascent and descent in decimetres for the a-to-b
direction, swapped when ridden the other way. It takes 8 seconds over 1,5 M sample
points and comes to **1,4 MB gzipped**, of which the per-edge ascent is 0,4 MB and the
heights behind the profile chart the rest. Over the whole 21 641 km network it finds
351 km of climb, and half the edges rise at all.

It loads on the same terms as the address index: the page routes the moment the graph
lands and becomes hill-aware when this arrives. Without it every edge is flat, which
is exactly how the router behaved before there was such a thing as climb, and the
hills slider and its two model knobs stay hidden rather than offering a control that
cannot move anything.

### Is ascent per edge the same as ascent along the route?

Not exactly, and it is worth knowing by how much. The threshold is applied within each
edge and the edges are then summed, which cannot see a rise that straddles a junction —
and half the edges in this graph are under 28 m, barely two samples apart. Measured
against the same paths profiled end to end, per-edge summation comes out **4,4 % low**:
2 083 m against 2 178 m over the ten benchmark routes. Low rather than high, because
what it loses is sub-threshold rises at the seams, and conservative in the direction
that matters.

### Why the ascent is not the sum of the rises

Adding up every positive difference in a sampled profile is wrong, and wrong by a lot:
a terrain model has vertical noise, and summing it accumulates climb that is not
there. On the probe routes that inflated totals by 15-20 % — one 42 km route read
508 m raw against 426 m filtered. A rise is therefore committed only once it has been
given back by `--threshold` metres, the usual hysteresis fix, and the threshold is
recorded in the manifest because it is the number the output is most sensitive to.

### Building it

Needs an elevation model covering the region; [Maanmittauslaitos korkeusmalli 10 m][mml]
is lidar-derived, CC BY 4.0, and by far the best data for Finland. It is fetched with
a free MML API key, which is not committed anywhere.

```bash
python tools/build_climb.py path/to/dem-tiles/
```

Two things about MML's file service are not in its own documentation. Its OpenAPI
describes the execute body as `*/*` of type `string`, which describes nothing; what it
actually wants is the older OGC draft shape, with `id`, `mode` and `response` beside
`inputs`, and any other form returns a bare `HTTP 400`. And the 1:25 000 sheet names
run `1 = SW, 2 = NW, 3 = SE, 4 = NE` from an easting origin of −76 000 — not the
bottom-row-first order the obvious reading suggests. Helsinki centre is `L4133`.

Getting the grid wrong is quiet rather than loud: the wrong sheets download happily, at
the right resolution and the right file sizes, and read 0,3 m everywhere because they
are open sea a hundred kilometres west. Check a raster's own bounds against the sheet
you asked for.

Any CRS rasterio can read works — points are reprojected to meet it — but the tool
expects ETRS-TM35FIN (EPSG:3067) because that is what MML ships. A surface model such
as Copernicus GLO-30 will work and will be measurably worse: it includes tree canopy
and buildings, so forest paths and streets between blocks pick up relief that is not
ground.

[mml]: https://www.maanmittauslaitos.fi/en/maps-and-spatial-data/expert-users/product-descriptions/elevation-model-10-m

## Reading the route

The panel breaks the ride into steps the way a navigation app does — a step per
manoeuvre, with its distance, the street it runs along and what it costs in lights
and crossings — and the map marks every traffic light on the chosen route. Clicking
a step flies the map to that corner.

A route runs between junctions, so it begins at the nearest one — the median building
in the region is 24 m from it, some are hundreds — and the last stretch to the pin is
drawn as a dashed stub rather than left as a gap. Without it the line simply stops
short of the marker, which reads as a bug, and is what dragging a pin makes obvious.

The steps break exactly where the *search* charged a turn, so the list is not a
commentary written over the route: it is the same manoeuvres the route was priced
on. Two turns closer together than `turn_merge_m` (25 m) are shown as one, because
a staggered crossing is one decision, not a left immediately followed by a right.

This needed two things the graph did not carry. Street names are now interned once
and indexed per edge, each contracted edge taking the name of the way carrying most
of its metres — a stretch typically runs over a named street and an unnamed
connector, and the rider knows it by the street. And each shape point now ships its
node kind, which is what puts the lights on the map: contraction dissolves every
degree-2 node, and **60% of the region's signals stand at one** (3,907 of 6,528), so
a graph that only counted them per edge could say a route passes six lights while
being able to draw two. Together they cost about 0.6 MB gzipped.

## Alternatives

The panel offers up to three ways of making the same trip, best first, and the map
draws the unchosen ones dashed behind the blue line; clicking either the row or the
line switches. A single shortest-path search has only one answer, so each further
route comes from searching again with the roads already offered made 1.6× more
expensive. A candidate is kept only if it costs no more than 1.3× the best and
shares under 70% of its length with a route already on the list — otherwise it is
the same ride with one block swapped, which is not a choice. Every route is then
priced at its true cost, not the inflated one that made the search look elsewhere.

The point is that the cheapest route by this cost model is not always the one the
rider wants — a familiar street, a quieter one, an errand on the way — so each row
carries the two numbers the model cannot weigh for them, lights and turns, and not
just the minutes it can.

## The panel

On a desktop the panel is a card over the left of the map, and the map frames each
route around it — the fit pads left by the panel's own width, so a route is never
drawn underneath the thing describing it. It frames the drawn route rather than its
two endpoints, because a route detouring around a bay runs well outside the box its
ends make, and half of it ends up off-screen.

On a phone it is a bottom sheet instead. A card sized for a laptop covers a 375x812
screen whole, which leaves the route it has just drawn invisible — the one thing the
rider came for. Collapsed, the sheet shows the two fields and the headline answer and
nothing else; the grip drags it open, and a tap toggles it. How far down it sits is
measured from the panel to the bottom of the headline rather than summed from the
heights of the parts, so it stays right whatever happens to wrap. The map's own
zoom and locate controls ride above whatever height the sheet currently has.

The page follows the system's light and dark setting. Dark mode swaps the basemap for
CARTO Dark Matter rather than filtering the light one: inverting Positron turns the
land black and the sea pale, which reads as a photographic negative of a map.

How the duration is arrived at is a paragraph worth reading once and never again, so
it is folded away under the readout rather than standing between the rider and the
answer.

### Reaching it without a mouse

The address fields are comboboxes in the ARIA sense — `aria-expanded`,
`aria-controls`, `aria-activedescendant` — because the suggestion list is useless to
a screen reader otherwise: arrowing through it changes something visible and
announces nothing. The route alternatives are a radio group rather than a listbox,
since choosing one of three is what radios narrate and it needs no keyboard model
invented for it. The duration, the distance and the number of waits are announced
through a polite live region when a route is computed, because on this page the
answer arrives without anything being navigated to.

The suggestion list sits in the flow rather than overlaid: absolutely positioned, it
was clipped by the panel's own scroll container and cut the last match in half.

## Where the riding happens

Five traffic classes do not fit a table row, and "65 % pyöräväylää" answers a
different question from the one the traffic preference is about. The panel draws a
stacked bar instead — car-free, calm, moderate, busy, arterial — which is the shape
Komoot and Strava both settled on and the only place in the page that uses more than
one hue.

## How rough is the rough

One `slow_speed_factor` for everything unpaved charged a compacted park path what it
charged a mud track. Version 9 grades it in three:

| grade | rolls at | of the network |
|---|---|---|
| firm — compacted, fine gravel, pebbles | 0,80 × | 2 522 km |
| rough — cobbles, setts, boards | 0,65 × | 53 km |
| loose — ground, dirt, sand, mud | 0,55 × | 3 494 km |

Sharing with people on foot keeps the single factor, because a crowd is not a surface.
The grade is the one carrying most of the edge's *rough* metres, not most of its
metres: a paved street with 30 m of gravel on it should say how bad that 30 m is.

## Counting bicycles, and what it is good for

Helsinki counts bicycles at 427 places and publishes the daily totals. It is tempting
to route on that — and wrong. 427 points against 425 000 edges is a preference that
would touch almost nothing, and propagating counts along corridors to fill the gaps
would be inventing data and calling it observation.

What the counts are the right size for is checking the model. `bench_counters.mjs`
routes a few hundred trips, counts how often each edge is used, and compares the
ranking with the counts observed where a counter sits on an edge.

The first answer was a rank correlation of **0,27**, with zero trips past the busiest
counters in the city — which says nothing about the router and everything about the
demand model behind it. Trips between uniformly random junctions almost never cross
the centre, and cycling here is radial. Drawing destinations from the ten places
people actually ride to lifts it to **0,31** and puts 39 trips through Kaivokatu.

That is a modest correlation and it is reported as one. Half of what it measures is
the demand model, which is ten hardcoded destinations and no population data at all;
it is the weaker half, and the number should be read as "given roughly realistic
demand" rather than as a property of the router.

## Telling it what you like

The gear opens two tabs, and the split between them is the whole design.

|  | steers the route | changes the minutes |
|---|---|---|
| **Malli** — speed, light wait, turn cost, left-turn factor, crossing, surface factor | yes | **yes** |
| **Mieltymykset** — avoid cars, gravel, sidepath roads, turns, lights; prefer baanat | yes | **no** |

Moving a *model* number is a claim about the world: if a light really holds you for
45 s rather than 30, the ride really does take longer and the readout has to say so.
A *preference* is a claim about nothing at all. "I hate gravel" is not a duration, so
letting it into the cost would leave the panel reporting minutes that are not
minutes. It steers the search and stops there, which is what `SIDEPATH_PENALTY`
already did for one case and now does for six.

Concretely: every aversion multiplies the part of the cost it is about — gravel the
slow metres, waiting the light delay — and the whole edge is then scaled by what kind
of way it is. `route.seconds` is summed from the untouched model, so the same route
costs the same number of minutes however it was found. A profile left alone
reproduces the shipped routing exactly, which `test/profile.test.ts` asserts.

Two consequences worth knowing. Once a preference is set the first alternative is no
longer the quickest, so it stops calling itself *nopein* and says *paras
asetuksillasi*, with the others offset against it in both directions. And a
preference is a multiplier **below** one, which is exactly what A* forbids: the
straight-line heuristic stops being a lower bound. It is now scaled by the deepest
discount on offer, which the shipped `network_bonus` of 0.9 had quietly needed all
along.

### Where the numbers came from

`scripts/bench_profiles.mjs` sweeps one multiplier at a time over the ten benchmark
pairs and re-prices every result at the *shipped* model, the same trick
`bench_turns.mjs` uses, so a route found by hating gravel is still scored at what it
actually takes. The weakest avoiding stop is where the metric moves but the detour is
near nothing; the strongest is the knee, past which more multiplier buys almost
nothing. Nothing on this scale was chosen by taste.

| row | shipped | at the strongest stop | costs |
|---|---|---|---|
| Autojen seassa ajo | 78 % pyörätietä | **96 %** at ×8 | +7 % |
| Sora ja muu päällystämätön | 10,5 % soraa | **0,7 %** at ×4 | +6 % |
| Jalankulkijoiden kanssa jaettu | 40 % jaettua | **5 %** at ×4 | +14 % |
| Baanat ja pyöräreitit | 49 % viitoitettua | **59 %** at ×0,6 | +2 % |
| Ajorata pyörätien vierellä | 37 % at ×1 | **0,2 %** at ×20 | +4 % |
| Mäet | 2 083 m nousua | **1 067 m** at ×20 | +13 % |
| Käännökset | 569 | **300** at ×5 | +6 % |
| Liikennevalot | 97 odotusta | **15** at ×8 | +3 % |

These are measured with the hill cost switched on, so the baseline is the one a rider
actually gets: 218,5 km and 1 154 minutes over the ten pairs, against 1 081 before
climbing cost anything. Hills are the one row with no knee — there is no point past
which avoiding them stops working, only a price that keeps rising — so its strongest
stop is set by what the other rows cost rather than by the shape of its own curve.

Two of those ceilings are set by something other than diminishing returns. Avoiding
gravel harder than ×4 starts sending the search onto sidepath carriageways to escape
it — 10 % of the ride at ×8 — which is a worse answer than the gravel was. And no
stop is infinity: forbidding sidepath roads outright is what left four of these ten
pairs unable to connect at all, so a hard no stays a large finite number or it stops
being a preference and becomes a bug.

Avoiding lights turns out to be remarkably cheap here — two thirds of the waits go
for 0,3 % more riding — and the first notch away from gravel is free outright, 49 %
down to 41 % for no measurable detour.

### Presets, and the one that is missing

Four: *Tasapainoinen*, *Rauhallinen*, *Suoraviivainen*, *Asfaltti*. There is no
"fastest", because the shipped model already minimises perceived time and a preset
that dropped its preference for signposted routes measured **slower** — 1089 minutes
against 1081. A baana is not merely pleasant, it is quick, and a button promising to
save time while costing it would be a lie.

Under the rows, *Omat painot* takes the raw multiplier for any of them, so the scale
is a shortcut rather than a fence.

### Where it is kept

`localStorage`, under a key carrying a schema version; a stored profile that no
longer parses is discarded rather than migrated, because the settings are three
clicks to rebuild and routing someone by a rule they no longer hold is worse than
forgetting it. Anything blocked or corrupt reads as "no saved profile".

## Sharing a route

The trip lives in the query string — `?a=lon,lat&b=lon,lat`, plus `&v=` for a speed
and `&p=` for a profile that differs from the shipped one — so it can be bookmarked,
reloaded and sent to someone else,
which is the first thing anyone tries after finding a route they like. The button in
the panel's header puts that URL on the clipboard, or opens the phone's own share
sheet where there is one.

Copying a URL has no single reliable implementation: the async clipboard needs the
document focused and a permission some browsers withhold, and `execCommand` is
deprecated but still works where that fails, so all three routes are tried in turn
and the rider is told plainly if none of them worked.

A link carries coordinates, not names — a name is thirty characters of URL for
something the address index works out in a millisecond. Ends restored from a link are
labelled by their coordinates until that index lands, and renamed the moment it does.

`&p=` writes only what differs from the shipped model, one letter per field, so an
ordinary trip stays an ordinary link and a later recalibration is inherited rather
than frozen into every link ever shared. A profile arriving in someone else's link is
used for that visit and not saved: adopting it silently would rewrite the rider's own
settings from a link they did not write, and ignoring it would show them a different
route from the one that was shared. They are told, and can keep it or dismiss it —
and touching any control counts as keeping it.

## Finding a place

Two always-visible fields with a swap between them and picking straight off the map
— the shape HSL Reittiopas and Google Maps both settled on. Digitransit's own
autosuggest treats *current position* and *map position* as search results alongside
addresses, which is what lets one control handle every way of naming a place; this
follows that.

The button inside each field is *my location* while the field is empty and *clear
it* once it is not: the same swap those two apps make, and the only way to unset an
end without selecting the text by hand. Which of the two a map click will fill is
marked on the field itself, dashed, because otherwise clicking the map is a guess
about where the pin will land.

Search runs **entirely offline**, against an index built from the same OSM extract
as the graph: 122,583 addresses on 11,686 streets, a further 3,359 named roads that
no building is addressed to (through-roads, paths, park routes), 1,123 districts and
31,050 named destinations — 1.42 MB gzipped. Every street carries a representative
point, so a number that does not exist still lands you on the street rather than
returning nothing. Typing is matched with the Nordic vowels folded, so `hameentie 15`
finds *Hämeentie 15*. A district ranks above the streets that merely share its
prefix — `Kallio` offers the neighbourhood first, `Kalliot` drops it and offers
Kalliotie.

### Naming the place, not the address

Nobody rides to *Mannerheimintie 13b*; they ride to Musiikkitalo. So the index
carries what OSM calls destinations as well as addresses — museums, stations, malls,
parks, islands, sports halls, shops, cafés — each with the street it stands on, which
is both the line under the name and what tells two branches of one chain apart.

A place is named by more than its `name`: Oodi is tagged *Helsingin keskustakirjasto
Oodi* with `short_name=Oodi`, and Swedish names are what half the region's signage
says, so `short_name`, `alt_name`, `loc_name`, `official_name`, `name:sv` and
`name:en` are all indexed at the same point. The kinds are ranked, most prominent
first, and stations sit *below* the landmarks on purpose: a stop is named after the
place it serves, so `Korkeasaari` typed in full should mean the island, not a ferry
berth 9 km away that borrowed the name. One name may appear at most five times,
spread across the region rather than clustered in whichever suburb sorts first.

Namesakes are real: Korkeasaari is both the Helsinki island with the zoo on it and a
bare skerry off Espoo, and the index carries both. A `wikidata` or `wikipedia` tag is
how OSM says which one anybody has heard of — the signal Nominatim ranks on — except
that here *both* islands have one. Wikipedia's own title settles it: the Helsinki
island is `fi:Korkeasaari` and the skerry is `fi:Korkeasaari (Espoo)`, and that
parenthetical is the encyclopaedia saying which one needs disambiguating. A title
that matches the name outright wins; it is used for ordering namesakes and nothing
else.

Streets still come before any place that merely *begins* with what has been typed:
`Manner` is how you start typing Mannerheimintie, not how you look for the statue on
it. Only an exact name jumps the queue.

### How well it finds things

`scripts/bench_search.mjs` asks the index for 36 places a rider would actually name
— Musiikkitalo, Sello, Korkeasaari, Messukeskus, Helsinki-Vantaan lentoasema — and
checks the answer against the coordinates OSM itself gives them, extracted from the
same extract the index is built from (`scripts/search-truth.json`). A miss therefore
means the index does not carry the place, not that OSM does not know it. Where two
places share a name the pick is a judgement call, made by hand and marked with a
`note` in that file: no automatic rule can say that `Korkeasaari` means the island
with the zoo, and scoring against a rule the index already applies would only test
it against itself.

| | top 1 | top 3 | in the list of 7 |
|---|---|---|---|
| before, addresses and districts only | 44% | 50% | 50% |
| with destinations indexed | 97% | 100% | 100% |
| …typing only the first 60% of the name | 69% | 92% | 94% |

Typing half a name is the harder case, and the four it still ranks below the top
three are all queries where a street legitimately wins the prefix: `Sel` is the
start of Selintie as much as of Sello. A query costs about 1 ms against 32 k places
and 15 k streets, up from 0.3 ms: still
a tenth of a frame, and it is a linear scan, so there is still no index structure to
keep in step with the data.

### Why not a geocoding API

| Option | Why not |
|---|---|
| [Digitransit][dt] (what Reittiopas itself uses) | needs a subscription key, and a static page can only ship it to the client |
| [Nominatim][nom] | 1 request/second, and its policy forbids autocomplete-style querying outright |
| [Photon][ph] public instance | no availability guarantee, throttles or bans heavy use |
| [DVV national address extract][dvv] | open distribution ended in March 2025 |

Bundling the index costs ~10% on top of the graph and removes the key, the rate
limit, the third-party dependency and the network round-trip per keystroke. It also
keeps working offline, which matters for something opened on a phone mid-ride.

The authoritative alternative is the regional address list published by Helsinki,
Espoo, Vantaa and Kauniainen ([Pääkaupunkiseudun osoiteluettelo][hri], CC BY 4.0).
It is a worthwhile upgrade — it is maintained from the cities' own address
decisions and carries Swedish street names — but it needs a WFS fetch and its own
licence notice, which OSM, already attributed for the routing graph, does not.

[dt]: https://digitransit.fi/en/developers/apis/3-geocoding-api/
[nom]: https://operations.osmfoundation.org/policies/nominatim/
[ph]: https://github.com/komoot/photon
[dvv]: https://www.avoindata.fi/data/fi/dataset/rakennusten-osoitetiedot-koko-suomi
[hri]: https://hri.fi/data/dataset/seudullinen-osoiteluettelo

## Layout

```
tools/build_graph.py     OSM extract -> public/graph/{graph.bin.gz,graph.json}
tools/fetch_signals.py   the cities' signal registers -> tools/signals.json
tools/audit_signals.py   checks the built graph back against those registers
tools/build_search.py    OSM extract -> public/graph/{search.bin.gz,search.json}
tools/fetch_dem.py       MML korkeusmalli 10 m tiles for the graph's bounds
tools/fetch_counters.py  Helsinki's bicycle counts, for bench_counters.mjs
tools/build_winter.py    the city's winter network matched onto the built graph
tools/build_climb.py     terrain model + the built graph -> public/graph/climb.*
tools/build_all.sh       all three stages, in dependency order
tools/test_build_graph.py
tools/test_build_climb.py
src/graph.ts             decodes the binary graph, builds adjacency
src/route.ts             turn-aware A* over directed edges
src/search.ts            offline address search and nearest-address lookup
src/endpoints.ts         geolocation, bounds check, coordinate labels
data/                    build inputs: the extract and the elevation tiles (gitignored)
src/climb.ts             per-edge ascent, loaded beside the graph
src/profile.ts           the rider's model and preferences, and how they persist
src/settings.ts          the panel behind the gear
src/main.ts              the page
scripts/bench.mjs        routes a list of pairs headlessly, for calibration
scripts/bench_riding.mjs which side of the kerb those routes ride on
scripts/bench_signals.mjs what the lights cost, and waits against stops
scripts/bench_turns.mjs  what the turn penalty buys, swept
scripts/bench_search.mjs how often the index finds a place you can name
scripts/bench_profiles.mjs what each preference buys, and what the detour costs
scripts/bench_counters.mjs the routes' flow against Helsinki's own bicycle counts
```

## Building the graph

Only needed to refresh the data — `public/graph/` is committed, so deploying does
not require it. Needs an `.osm.pbf` covering the region; the [HSL extract][hsl] or a
Geofabrik Finland extract both work.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r tools/requirements.txt
echo <your-key> > tools/.mml-key      # free, for the elevation tiles
mv <extract>.osm.pbf data/            # anything in data/ is found automatically
tools/build_all.sh                    # or: npm run build:data
```

`data/` is gitignored and holds the build's *inputs* — the OSM extract and the
elevation tiles, about 870 MB together. Keeping them there is what makes a rebuild
one command with nothing to remember; the tiles are fetched into `data/dem` on the
first run and reused afterwards. The repository commits the *outputs*, in
`public/graph/`, which is all that deploying needs.

`build_all.sh` runs the three stages in the order they depend on each other, since
climb is sampled against the graph that has just been built and has to come last. It
fetches the elevation tiles first if none are present and a key is available — from
`MML_API_KEY`, or from `tools/.mml-key`, which is gitignored so that the convenience
of not retyping it does not put a credential in a public repository — and skips climb
with a warning if there are no tiles and no key — without it the page prices
every route flat, which is what it did before hills existed. Each stage also runs on
its own:

```bash
python tools/build_graph.py  data/finland.osm.pbf public/graph
python tools/build_search.py data/finland.osm.pbf public/graph
python tools/fetch_dem.py    data/dem public/graph
python tools/build_climb.py  data/dem public/graph
```

The extract must cover the whole region. BBBike's Helsinki extract is a tenth the
size of Geofabrik's Finland and tempting for it, but its box stops at 24,588°E and
60,353°N, which cuts off Espoonlahti, Kauklahti, Korso and Östersundom — four of the
ten benchmark pairs.

The pipeline is reproducible: building twice from one extract gives byte-identical
files, which is worth keeping, because it makes a real change to the data visible in
a diff instead of hidden among rebuild noise. All three builders pass `mtime=0` when
they gzip for that reason.

Takes about 15 minutes for the region — the graph is 10 of them, the address index 4,
and climb a handful of seconds — and writes `public/graph/`. Defaults to the HSY area
(Helsinki, Espoo, Vantaa, Kauniainen); pass `--full` to keep the whole extract,
which roughly doubles the download.

[hsl]: https://www.hsl.fi/en/hsl/open-data

## Developing

```bash
npm install
npm run dev
npm test
```

## Deploying to GitHub Pages

`vite.config.ts` bakes in a base path, which for a project page must match the
repository name. It defaults to `/helsinki-cycling-planner/`; override it if the
repository is named something else:

```bash
VITE_BASE_PATH=/helsinki-cycling-planner/ npm run build
```

`dist/` is then the site. `public/graph/` is committed as normal files — ~8.7 MB for
the graph and ~1.4 MB for the address index, well under GitHub's 100 MB limit, and
Pages serves them fine. The
loader sniffs the gzip magic bytes rather than trusting `Content-Encoding`, so it
works whether the host serves the file raw or inflates it.

## Relationship to the Helsinki housing map

The cost model was calibrated for that project's cycling layer, against CROW and
Fietsbalans thresholds and BRouter's turn counts. **No code is shared.** The
constants are duplicated here deliberately, and `test_build_graph.py` pins them, so
that changing one side fails loudly instead of letting the two drift apart in
silence. This service builds, tests and deploys on its own.

The two also differ by design: the housing map measures turns after routing, this
one avoids them during it.

## Coverage

Verified against the region's building register (106,483 buildings labelled by
municipality): **every building in Helsinki, Espoo, Vantaa and Kauniainen falls
inside the graph**, and the median building is 24 m from a routable junction
(p90 56 m, p99 130 m). Routes were checked between all four municipalities,
including the 41 km extremes Kauklahti → Vuosaari and Östersundom → Espoonlahti.

561 buildings (0.53%) sit more than 500 m from the network. They are all in the
outer archipelago, and snapping to the road geometry rather than to junctions does
not help them (558 of the same buildings) — they are islands with no bridge, which
a bicycle genuinely cannot reach. The housing map's independent cycling layer
cannot route 526 of the same buildings.

## Accuracy

Routes and addresses come from OpenStreetMap, so coverage of `surface`, `crossing`,
`traffic_signals` and `addr:*` varies. Most Helsinki addresses sit on the building
polygon rather than a node — 41 k addressed nodes against 249 k addressed areas — so
the index is built from both. Signals are OSM-derived; the cities publish authoritative
signal datasets (Helsinki, Espoo and Vantaa all do, CC-BY) which would be a
worthwhile upgrade. The default 18 km/h is a fit-commuter pace on the flat; use the
slider.

Geolocation needs HTTPS, which GitHub Pages provides. A fix outside the graph's
bounding box is refused rather than snapped to the nearest junction, which could
otherwise be a hundred kilometres away.
