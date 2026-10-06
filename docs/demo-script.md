# Prism demo script

A run of about 3 minutes 45 seconds. The times are a plan, not a measurement: rehearse once
with a stopwatch before presenting, and trim the NeedsBox step first if you are over.

## Before you start (not part of the 4 minutes)

1. Seed the demo with progress, so the last screen has something on it even if time runs out:
   `DEMO_PASSWORD=<8+ characters> npm run seed:demo -- --with-progress`
2. Open the deployed site in one window, signed in as the teacher (`demo.teacher@prism-demo.test`).
3. Open `/demo` in a second window and wait for "Ready to use without a connection".
4. Have `src/tests/fixtures/demo/water-cycle.pdf` ready to upload.
5. Check the microphone works in the browser you will use. Speech input is an extra; typing
   always works.

## The run

| Time | What you do                                                                                                                                   | What to say                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open `/teach/upload`. Choose `water-cycle.pdf`, press upload.                                                                                 | "A teacher uploads one reading. That is the only work they do."                                                                                                 |
| 0:20 | While it processes, open the pre-seeded lesson's review page. Point at the concepts and the quiz questions.                                   | "Prism turns it into ideas and questions. The teacher checks and corrects it before any student sees it, because AI extraction can be wrong."                   |
| 0:50 | Press Publish.                                                                                                                                | "Published. Now the same lesson, three students."                                                                                                               |
| 1:00 | Switch to the `/demo` window. Pick **Maya**. Start, press Next twice, answer the question that appears.                                       | "Maya likes one idea at a time. Short cards, a quick question, a visible streak."                                                                               |
| 1:35 | Pick **Tunde**. Press Start. Let it speak, then say or type "why does a puddle dry up?".                                                      | "Tunde talks it through. He can interrupt any time by pressing a key, and he can turn Prism's voice off and use his own screen reader."                         |
| 2:15 | Pick **Sofia**. Press Start, then **See it signed** or point at the fingerspelled term.                                                       | "Sofia gets plain wording, with each key term signed or fingerspelled. We say plainly: this is key terms, not a full translation."                              |
| 2:45 | Ask the audience for one need. Type it into **Tell Prism what you need** ("make the text bigger and read it to me"). Press Update, then Undo. | "No one has to name a label. They say what helps and Prism changes the settings. It shows what changed and lets them undo it."                                  |
| 3:15 | Open the lesson's **progress** page (`/teach/lessons/<id>/progress`).                                                                         | "Three students on three different layouts, on one scale: ideas mastered out of ideas in the lesson. The teacher sees progress, not how anyone chose to learn." |
| 3:40 | Stop.                                                                                                                                         | "Same lesson, same measure, a different way in for each student."                                                                                               |

## If something goes wrong

- **Upload is slow or fails:** carry on from the pre-seeded lesson. Say it ran earlier.
- **The network drops:** the `/demo` window keeps working. Only the needs box and free
  questions need a connection; skip that step.
- **Voice is silent:** the browser may need a click first. Use the transcript, which shows
  everything Prism says.
- **No microphone:** type into the box under the transcript. It is an equal way in.

## What not to claim

- Signs are for key terms only, and the demo fingerspells them. Do not call it translation.
- Profiles are preferences, not diagnoses. Do not name a condition when introducing a student.
- The progress page is a demo of one lesson. The school dashboards are not built yet.

## Clean up

`npm run seed:demo -- --teardown` removes the demo accounts, lesson and progress.
