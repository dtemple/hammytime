# Glossary — concept terms

Canonical source for the runner-jargon glossary surfaced at `daybreak.run/glossary`. Same idea as
`worker/knowledge/exercises.md`, but for **concepts** rather than movements. Exercises already link
to their YouTube demos via `exercises.md`; this file covers the terminology athletes hit in chat and
don't always know.

Every term has a stable `slug`. The slug is the anchor on the glossary page, so a link resolves to
`https://daybreak.run/glossary#<slug>` and lands the athlete on that exact definition.

## Why these terms

Pulled from the five real athlete transcripts in `/transcripts`. Selection rule: a term made the
list only if the bot actually uses it **and** it's plausibly opaque to a non-coach. Direct evidence
of confusion in the transcripts — one athlete asked "What does 'RPE' mean?", and the all-caps
acronyms the bot leans on (RPE, DOMS, ITB) are exactly the ones a newcomer can't expand. Exercise
names (dead bug, RDL, TKE band, single-leg calf raise, Bulgarian split squat) are **deliberately
excluded** — those are owned by `exercises.md`.

## Linking convention

Same `[the words you'd say](slug)` form the coach already uses for exercises and the reserved
`prehab-routine` token. To turn these on for the coach, the slug resolver needs to map a glossary
slug to `daybreak.run/glossary#<slug>` (mirror of how `prehab-routine` resolves to the athlete's
personal page). Example the bot would write: `effort sits at [RPE](rpe) 3–5 the whole way`.

---

## Effort and workouts

### RPE
- **slug:** `rpe`
- Rate of Perceived Exertion — a 1–10 scale for how hard a run feels from the inside, where 1 is barely moving and 10 is an all-out sprint you couldn't hold for more than a few seconds. Daybreak prescribes effort in RPE instead of pace because it adjusts itself to heat, hills, fatigue, and how you slept. Easy and long runs sit at RPE 3–5, where you can hold a conversation; a tempo runs at RPE 6–7, short phrases but not gasping.

### Conversational pace
- **slug:** `conversational-pace`
- An effort easy enough that you could speak in full sentences without pausing for breath — roughly RPE 3–5. It's the target for most easy and long runs. If you're breathing too hard to recite a sentence, you're going too fast. Most runners run their easy days too hard, then can't hit the quality on their hard days.

### Strides
- **slug:** `strides`
- Short, smooth accelerations — about 20 seconds building to roughly 80% effort, then a full jog or walk to recover before the next. Usually 4–6 of them tacked onto the end of an easy run. They wake the legs up and sharpen form without adding real fatigue. Not sprints.

### Tempo
- **slug:** `tempo`
- A sustained, comfortably-hard effort at about RPE 6–7 — the pace where you can manage short phrases but not full sentences. Tempo work trains you to hold a strong effort for longer. It should feel controlled, not like a race.

### Fartlek
- **slug:** `fartlek`
- Swedish for "speed play." An easy run with surges thrown in whenever you feel like it — 30–60 seconds faster on a straight stretch, a hill, or a good song, then back to easy. No timer, no structure. Same total distance as the easy run; you're just making decisions during it instead of cruising.

### Intervals
- **slug:** `intervals`
- Repeated bursts of harder running separated by easy recovery — for example 5 × 3 minutes hard with a jog between each. The recovery is the point: it lets you bank more total time at a strong effort than you could in one continuous push.

## Plan structure

### Long run
- **slug:** `long-run`
- The longest run of your week and the backbone of endurance training. Run it easy (RPE 3–5) unless told otherwise — the goal is time on your feet, not speed. It builds the aerobic engine and durability that carry you through a race.

### Easy / recovery run
- **slug:** `easy-run`
- A deliberately gentle run at conversational effort (RPE 3–5). Its job is to build aerobic fitness and let you recover while still moving, not to tire you out. Run the easy ones easy so you can run the hard ones hard.

### Base
- **slug:** `base`
- The early phase built on easy aerobic mileage, before much hard work goes in. It lays the foundation — the aerobic and structural stuff like tendon resilience — that later speed work sits on top of.

### Build
- **slug:** `build-phase`
- The phase where weekly mileage and the long run grow and harder sessions like tempo and intervals get added. It's the main stretch of training, between base and peak, where most of the fitness gets constructed.

### Peak
- **slug:** `peak`
- The highest-volume, highest-intensity stretch of the plan, a few weeks out from the race. It's the hardest training you'll do before the taper, where the biggest long runs and toughest sessions land.

### Taper
- **slug:** `taper`
- The planned drop in training volume over the last one to three weeks before a race, so you show up fresh. You keep a little intensity to stay sharp but cut the total load. Restless legs during a taper are normal and usually mean it's working.

### Cutback week
- **slug:** `cutback-week`
- A planned lighter week — lower mileage, shorter long run — dropped in every few weeks. It's when the training you've already done actually sticks, by giving your body room to absorb it. Treat it as mandatory; skipping cutbacks is how you dig a hole.

### Shakeout
- **slug:** `shakeout`
- A very short, very easy run — often 2–3 miles, sometimes with a few strides — a day or two before a race. It loosens the legs and keeps you moving without adding fatigue. The opposite of a workout.

### Tune-up race
- **slug:** `tune-up-race`
- A smaller race run during training as preparation for your goal race. It's a chance to rehearse pacing, fueling, and race-morning logistics, and to read your fitness — usually run as a hard effort rather than an all-out peak.

## Body and recovery

### DOMS
- **slug:** `doms`
- Delayed Onset Muscle Soreness — the stiffness and ache that show up a day or two after a hard or unfamiliar session, especially one with a lot of downhill. It's normal and fades within a few days; it isn't an injury. Easy movement helps more than sitting still.

### ITB
- **slug:** `itb`
- Iliotibial band — a thick band of connective tissue running down the outside of your thigh, from hip to just below the knee. When it gets irritated it causes pain on the outer knee, often on longer runs and steep downhills. It's common in runners and is usually managed with strength work and load management, not stretching alone.

### Niggle
- **slug:** `niggle`
- A minor, nagging ache or tightness that isn't a real injury but is worth watching. Flagging one early lets the plan adjust before it turns into something bigger. Sharp pain, swelling, or anything that changes how you run is past this — that's a see-a-professional signal.

### Prehab
- **slug:** `prehab`
- Short for preventative rehab: the small routine of strength and mobility movements built into your week to keep weak spots resilient and head off injury before it starts. Rehab is the same idea aimed at something already bothering you. Daybreak keeps the set short and targeted rather than a full gym session.

### Readiness and soreness
- **slug:** `readiness`
- The two quick numbers Daybreak asks for on a check-in: readiness (1–10, how recovered and ready to train you feel) and soreness (1–10, plus where, if anywhere). They let the coach tune the day's run to how your body actually is, instead of only what the plan says.

### Eccentric
- **slug:** `eccentric`
- The lengthening phase of a muscle working under load — the lowering part of a heel drop, or how your quads fire while braking on a downhill. Eccentric loading builds strength and resilience, but it also causes more soreness, which is why long descents leave you sorer than the climb.

### Cadence
- **slug:** `cadence`
- Your step rate — how many steps you take per minute. A lighter, quicker cadence, especially on downhills, cuts braking and impact on the knees. It's a form cue, not a number to obsess over.

## Terrain and fueling

### Vert
- **slug:** `vert`
- Short for vertical gain: the total elevation you climb over a run, in feet or meters. On trails the vert often matters more than the distance — "4 miles with 2,000 ft of vert" is a very different day than 4 flat miles.

### Fueling
- **slug:** `fueling`
- Glycogen is the carbohydrate your muscles and liver store for fuel, and it's the main energy source for hard and long efforts — it starts running low after about 90 minutes. Fueling means taking in carbs before and during longer runs, and topping up your stores beforehand, so you don't hit the wall.
