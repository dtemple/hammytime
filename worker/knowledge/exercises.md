# Exercise library — prehab + strength

Read-only reference for the coaching agent. When an athlete reports a niggle/soreness, asks how
to do a movement, or you're prescribing strength/mobility work, pull the exercise from here, quote
the cues, and use the canonical link.

## Rules for the agent

- **This library enriches your advice — it does not limit it.** Always recommend the best exercise
  for the athlete based on their situation, whether or not it appears here. When the exercise you're
  recommending IS in this library, grab its cues and `source` link to enrich the recommendation.
  When it isn't, give the recommendation normally, without a link — that's fine.
- **Never fabricate a video or article link.** The only exercise links you may send are the `source`
  URLs in this file. If an exercise you're recommending has no entry here, send no link for it —
  never invent a URL or attach one from a different exercise.
- **These are exercise suggestions, not rehab protocols.** Anything that looks like a real injury
  (pain that changes gait, sharp/localized pain, swelling, pain not improving) → tell the athlete to
  see a physio or doctor. Do not self-prescribe a rehab program.
- **Linking etiquette in chat:** link the exercise *name* to its `source` the first time you
  recommend it in a conversation. Don't paste the raw URL, and don't re-send the link every message —
  once per exercise per conversation is enough.
- The `source` for each entry is the page that *demonstrates* the movement (video + written
  technique). Most are E3 Rehab articles; two (front plank, dead bug) are curated YouTube videos.
  Several E3 articles are named after an injury (e.g. Achilles tendinopathy) — that's where E3
  teaches that exercise, and it's fine to link it; it also explains the "why."

## Source

Primary source: **E3 Rehab** (e3rehab.com) — Doctors of Physical Therapy, evidence-based, free.
Secondary (sanctioned) for runner-specific gaps: **Kinetic Revolution / James Dunne**
(kinetic-revolution.com). Two entries use individually curated YouTube videos (front plank, dead
bug). No other sources without sign-off.

All E3 links last verified live + content-matched: **2026-06-02**. The two YouTube links were
provided/curated by David.

## Deferred

- **Dynamic warmup drills** (leg swings, A-skips, strides, inchworm, etc.) are intentionally NOT in
  v1 — that's a separate "warmup/running drills" category. Flagged to revisit. See `claude-status.md`.
- The companion **`principles.md`** (house coaching defaults) is also deferred — David to author.

---

## Calf / Achilles / lower leg

### 1. Straight-leg (gastrocnemius) calf raise
- id: gastroc-calf-raise
- region: calf / Achilles
- targets: gastrocnemius; push-off power, Achilles load tolerance
- cues: knee straight; full stretch at the bottom and peak squeeze at the top, ideally off a step; slow — about 3s up, 3s down, no bouncing; train it heavy (6–12 hard reps).
- source: https://e3rehab.com/calves/

### 2. Bent-knee (soleus) calf raise
- id: soleus-calf-raise
- region: calf / Achilles
- targets: soleus — the runner's workhorse, often neglected
- cues: knee bent past ~60°, preferably seated so the quads aren't the limiter; same slow full-range tempo; load it (weight on thighs / machine).
- source: https://e3rehab.com/calves/

### 3. Eccentric heel drop
- id: eccentric-heel-drop
- region: Achilles
- targets: Achilles tendon load tolerance
- cues: single leg off a step, lower slowly into dorsiflexion (heavy-slow resistance); a little tolerable pain is OK — judge by the next-day response, not pain during. Back off if symptoms are clearly worse the next morning.
- source: https://e3rehab.com/achilles-tendinopathy/

### 4. Single-leg calf raise
- id: single-leg-calf-raise
- region: calf / Achilles
- targets: unilateral calf capacity + balance
- cues: full bodyweight through one leg; hands for light balance only; full range, controlled; progress to a step, then add weight.
- source: https://e3rehab.com/calves/

## Foot / ankle

### 5. High-load plantar raise (towel under toes)
- id: high-load-plantar-raise
- region: foot / plantar fascia
- targets: plantar fascia loading
- cues: single-leg heel raise on a step with a rolled towel under the toes to extend the big toe; slow tempo; this is the research-backed loading exercise for plantar heel pain.
- source: https://e3rehab.com/plantar-fasciitis-rehab/

### 6. Short foot / toe yoga
- id: short-foot-toe-yoga
- region: foot intrinsics
- targets: arch control, foot intrinsic muscles
- cues: short foot — draw the ball of the big toe toward the heel to lift the arch while keeping toes flat; toe yoga — lift the big toe while keeping the other four down, then reverse; 2–4 sets of 30–60s.
- source: https://e3rehab.com/foot-ankle-strength/

### 7. Knee-to-wall ankle dorsiflexion
- id: knee-to-wall-dorsiflexion
- region: ankle (mobility)
- targets: dorsiflexion range of motion
- cues: split or half-kneeling stance, drive the knee out over the second toe with the heel flat; hold 3–5s, or move in and out of end range; add gentle overpressure if needed.
- source: https://e3rehab.com/ankle-dorsiflexion/

## Knee / quad

### 8. Spanish squat (isometric)
- id: spanish-squat
- region: knee / quad
- targets: quad + patellar tendon load with low knee-joint stress (knee-friendly)
- cues: loop a strong band/strap around the backs of the knees, anchored to a rack; sit back until hips and knees are ~90°; hold (e.g. 3–5 × 45s at ~7/10 effort).
- source: https://e3rehab.com/patellartendinopathy/

### 9. Lateral step-down
- id: lateral-step-down
- region: knee / quad
- targets: eccentric quad control, knee tracking
- cues: stand on a step, slowly bend the stance knee and lightly tap the opposite heel to the floor, then back up; chest upright, let the knee travel over the toes; control the lowering.
- source: https://e3rehab.com/pfp/

### 10. Goblet squat
- id: goblet-squat
- region: knee / quad (foundational)
- targets: foundational bilateral leg strength
- cues: hold a kettlebell/dumbbell at the chest; sit down between the hips with a flat low back; heels-elevated biases the quads, an upright trunk with depth biases the glutes.
- source: https://e3rehab.com/how-to-grow-your-glutes/

### 11. Bulgarian (rear-foot-elevated) split squat
- id: bulgarian-split-squat
- region: knee / quad / glute
- targets: unilateral quad/glute strength, side-to-side imbalance
- cues: back foot on a bench, "laces down"; most weight (70–90%) through the front leg; tap the back knee toward the floor — the bottom of the range is where the value is; film yourself for feedback.
- source: https://e3rehab.com/how-to-perform-split-squats/

## Hip / glute

### 12. Single-leg glute bridge
- id: single-leg-glute-bridge
- region: hip / glute
- targets: gluteus maximus, posterior chain
- cues: drive through one heel, squeeze the glute hard at the top, knee ~90°; keep the low back neutral — don't arch to get higher.
- source: https://e3rehab.com/how-to-grow-your-glutes/

### 13. Side-lying hip abduction
- id: side-lying-hip-abduction
- region: hip / glute medius
- targets: gluteus medius — hip/pelvis control (hip drop, IT band)
- cues: keep the top leg in line with the trunk or slightly behind, hip in neutral or slight internal rotation; lift under control; add an ankle weight or band; on a bench for more range.
- source: https://e3rehab.com/how-to-train-your-gluteus-medius/

### 14. Banded lateral walk
- id: banded-lateral-walk
- region: hip / glute medius
- targets: gluteus medius under continuous tension
- cues: band around the knees, ankles, or feet; athletic half-squat stance; step sideways keeping tension the whole time; don't let the knees cave in.
- source: https://e3rehab.com/how-to-train-your-gluteus-medius/

### 15. Single-leg RDL
- id: single-leg-rdl
- region: hip / hamstring (+ balance)
- targets: posterior chain, hip-hinge control, balance
- cues: slight bend in the stance knee, hinge at the hip with a flat back until the trunk is ~parallel to the floor, then squeeze back up; hold a rack/dumbbell for balance so the hamstring stays the focus.
- source: https://e3rehab.com/how-to-grow-your-hamstrings/

### 16. Hip thrust
- id: hip-thrust
- region: hip / glute
- targets: maximal glute strength
- cues: upper back on a bench, knees at ~90° at the top, squeeze the glutes; minimize bending/arching the lower back; feet flat, hip-width.
- source: https://e3rehab.com/how-to-grow-your-glutes/

## Hamstring

### 17. Nordic hamstring curl
- id: nordic-hamstring-curl
- region: hamstring
- targets: eccentric hamstring strength — strain prevention
- cues: kneel on a pad with feet anchored; keep a straight line from knees to shoulders; lower slowly, resisting the fall forward; catch with the hands. It's brutal — start eccentric-only with a short range or band assistance.
- source: https://e3rehab.com/how-to-grow-your-hamstrings/

### 18. Romanian deadlift (RDL)
- id: romanian-deadlift
- region: hamstring / posterior chain
- targets: posterior-chain strength (hamstrings, glutes)
- cues: from standing, push the hips back and lower the bar/dumbbells close to the shins with a flat low back and a slight knee bend; feel the hamstring stretch near the bottom; don't round the back.
- source: https://e3rehab.com/how-to-grow-your-hamstrings/

### 19. Slider / supine hamstring curl
- id: slider-hamstring-curl
- region: hamstring
- targets: unilateral hamstring capacity (knee-flexion action)
- cues: on your back, bridge up, slide the heels out while keeping the hips extended, then pull back in; progress double-leg → single-leg, and eccentric-only → full range.
- source: https://e3rehab.com/how-to-grow-your-hamstrings/

## Adductor / groin

### 20. Copenhagen plank
- id: copenhagen-plank
- region: adductor / groin
- targets: adductor strength — a high runner-injury site
- cues: top leg supported on a bench, bottom leg underneath; lift the hips into a straight line with the legs together; lower slowly and tap, don't rest on the floor; regress by bending the top knee (support nearer the knee).
- source: https://e3rehab.com/how-to-perform-copenhagen-planks/

## Core / trunk

### 21. Side plank
- id: side-plank
- region: core / lateral chain
- targets: lateral trunk + pelvic control
- cues: forearm under the shoulder, feet stacked, straight line from trunk to ankle; regress onto the knees; progress by abducting the top leg.
- source: https://e3rehab.com/how-to-train-your-gluteus-medius/

### 22. Front plank
- id: front-plank
- region: core / anti-extension
- targets: anti-extension trunk stability, posture
- cues: forearms and toes, straight line head-to-heel, brace the abs and glutes; don't let the hips sag or pike.
- source: https://www.youtube.com/watch?v=U4OX9fKDJU8

### 23. Dead bug
- id: dead-bug
- region: core / control
- targets: core control + limb dissociation
- cues: on your back, hips and knees at 90°, flatten the low back into the floor; slowly extend the opposite arm and leg without letting the back arch off the ground.
- source: https://www.youtube.com/watch?v=BZYaCzbP09M

## Power / tendon

### 24. Diagonal pogo hops
- id: diagonal-pogo-hops
- region: calf / tendon (power)
- targets: calf-tendon stiffness, running economy
- cues: hands on hips, quick springy jumps off both feet with relatively straight knees; spend as little time on the ground as possible; start small and build height; 3 × 30–60s.
- source: https://e3rehab.com/strength-training-for-runners/
