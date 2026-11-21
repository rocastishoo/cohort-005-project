import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "./setup";
import { courses, enrollments, lessons, modules } from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { action } from "~/routes/courses.$slug.lessons.$lessonId";
import { loader as saved } from "~/routes/saved";
import { loader as roster } from "~/routes/instructor.$courseId.students";

let db: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));

function setup() {
  const { user, course, instructor } = seedBaseData(db);
  const module = db
    .insert(modules)
    .values({
      courseId: course.id,
      title: "Module",
      position: 1,
    })
    .returning()
    .get();
  const lesson = db
    .insert(lessons)
    .values({
      moduleId: module.id,
      title: "Lesson",
      position: 1,
    })
    .returning()
    .get();
  db.insert(enrollments).values({ userId: user.id, courseId: course.id }).run();
  return { user, course, instructor, lesson };
}

async function routeArgs(userId: number, form?: Record<string, string>) {
  const url = new URL("http://localhost/");
  const cookie = await setCurrentUserId(new Request(url), userId);
  const request = new Request(url, {
    headers: { Cookie: cookie.split(";")[0] },
    method: form ? "POST" : "GET",
    body: form ? new URLSearchParams(form) : undefined,
  });
  return {
    request,
    context: new RouterContextProvider(),
    url,
    pattern: "/",
    params: {},
  };
}

beforeEach(() => {
  db = createTestDb();
});

it("keeps notes and bookmarks private through the Saved and instructor roster loaders", async () => {
  const { user, instructor, course, lesson } = setup();
  const params = { slug: course.slug, lessonId: String(lesson.id) };
  async function submit(form: Record<string, string>) {
    return action({ ...(await routeArgs(user.id, form)), params });
  }
  await submit({ intent: "toggle-bookmark" });
  await submit({ intent: "save-note", body: "first draft" });
  await submit({ intent: "save-note", body: "private revision" });
  const mine = await saved(await routeArgs(user.id));
  expect(mine.savedNotes.map((note) => note.body)).toEqual([
    "private revision",
  ]);
  expect(mine.savedBookmarks).toMatchObject([
    { courseSlug: course.slug, lessonId: lesson.id },
  ]);
  expect(await saved(await routeArgs(instructor.id))).toEqual({
    savedBookmarks: [],
    savedNotes: [],
  });
  const response = await roster({
    ...(await routeArgs(instructor.id)),
    params: { courseId: String(course.id) },
  });
  expect(response.students).toHaveLength(1);
  expect(JSON.stringify(response)).not.toContain("private revision");
  await submit({ intent: "toggle-bookmark" });
  await submit({ intent: "save-note", body: "  " });
  expect(await saved(await routeArgs(user.id))).toEqual({
    savedBookmarks: [],
    savedNotes: [],
  });
});

it.each(["toggle-bookmark", "save-note"])(
  "checks enrollment and lesson membership for %s",
  async (intent) => {
    const { user, course, lesson } = setup();
    const { id, ...fields } = course;
    const other = db
      .insert(courses)
      .values({ ...fields, slug: "other" })
      .returning()
      .get();
    const params = { slug: other.slug, lessonId: String(lesson.id) };
    const args = () => routeArgs(user.id, { intent, body: "private" });
    await expect(action({ ...(await args()), params })).rejects.toMatchObject({
      init: { status: 403 },
    });
    db.insert(enrollments)
      .values({ userId: user.id, courseId: other.id })
      .run();
    await expect(action({ ...(await args()), params })).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(await saved(await routeArgs(user.id))).toEqual({
      savedBookmarks: [],
      savedNotes: [],
    });
  }
);

it("removes saved references when their lesson is deleted", async () => {
  const { user, course, lesson } = setup();
  const params = { slug: course.slug, lessonId: String(lesson.id) };
  for (const intent of ["toggle-bookmark", "save-note"]) {
    await action({
      ...(await routeArgs(user.id, { intent, body: "private" })),
      params,
    });
  }
  db.delete(lessons).where(eq(lessons.id, lesson.id)).run();
  expect(await saved(await routeArgs(user.id))).toEqual({
    savedBookmarks: [],
    savedNotes: [],
  });
});
