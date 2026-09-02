/*
 * =========================================================
 * RAUDA ILM
 * BOOKS / GRADES / RETAKES / ASSESSMENT ACCESS
 * =========================================================
 */

export async function handleAssessmentRequest(
    request,
    env,
    ctx
) {
    const url = new URL(request.url);
    const path = url.pathname;

    const adminBookMatch =
        path.match(
            /^\/api\/admin\/books\/(\d+)$/
        );

    const supported =
        path === "/api/books" ||
        path === "/api/grades" ||
        path === "/api/grades/details" ||
        path === "/api/assessment-access" ||
        path === "/api/admin/books" ||
        Boolean(adminBookMatch) ||
        path === "/api/admin/assessment-dashboard" ||
        path === "/api/admin/assessment-access-state" ||
        path === "/api/admin/assessment-access" ||
        path === "/api/admin/assessment-state" ||
        path === "/api/admin/assessment-book";

    if (!supported) {
        return null;
    }

    if (!env.DB) {
        return ctx.json(
            {
                ok: false,
                error: "Database is not configured"
            },
            500,
            env
        );
    }

    await ensureAssessmentInfrastructure(
        env.DB
    );

    /*
     * BOOKS
     */

    if (
        path === "/api/books" &&
        request.method === "GET"
    ) {
        return handleBooks(
            request,
            env,
            ctx
        );
    }

    if (
        path === "/api/admin/books" &&
        request.method === "POST"
    ) {
        return handleAdminBookCreate(
            request,
            env,
            ctx
        );
    }

    if (
        adminBookMatch &&
        request.method === "PATCH"
    ) {
        return handleAdminBookUpdate(
            request,
            env,
            ctx,
            Number(adminBookMatch[1])
        );
    }

    if (
        adminBookMatch &&
        request.method === "DELETE"
    ) {
        return handleAdminBookDelete(
            request,
            env,
            ctx,
            Number(adminBookMatch[1])
        );
    }

    /*
     * GRADES
     */

    if (
        (
            path === "/api/grades" ||
            path === "/api/grades/details"
        ) &&
        request.method === "GET"
    ) {
        return handleDetailedGrades(
            request,
            env,
            ctx
        );
    }

    /*
     * STUDENT ACCESS STATE
     */

    if (
        path === "/api/assessment-access" &&
        request.method === "GET"
    ) {
        return handleAssessmentAccess(
            request,
            env,
            ctx
        );
    }

    /*
     * ADMIN DASHBOARD DATA
     */

    if (
        path === "/api/admin/assessment-dashboard" &&
        request.method === "GET"
    ) {
        return handleAdminAssessmentDashboard(
            request,
            env,
            ctx
        );
    }


    if (
        path === "/api/admin/assessment-access-state" &&
        request.method === "GET"
    ) {
        return handleAdminAssessmentAccessState(
            request,
            env,
            ctx
        );
    }

    /*
     * ADMIN INDIVIDUAL ACCESS / RETAKES
     */

    if (
        path === "/api/admin/assessment-access" &&
        request.method === "GET"
    ) {
        return handleAdminAssessmentAccessList(
            request,
            env,
            ctx
        );
    }

    if (
        path === "/api/admin/assessment-access" &&
        request.method === "POST"
    ) {
        return handleAdminAssessmentAccessSave(
            request,
            env,
            ctx
        );
    }

    if (
        path === "/api/admin/assessment-access" &&
        request.method === "DELETE"
    ) {
        return handleAdminAssessmentAccessDelete(
            request,
            env,
            ctx
        );
    }

    /*
     * ADMIN GLOBAL OPEN/CLOSE
     */

    if (
        path === "/api/admin/assessment-state" &&
        request.method === "POST"
    ) {
        return handleAdminAssessmentState(
            request,
            env,
            ctx
        );
    }

    /*
     * LINK TEST/EXAM TO BOOK
     */

    if (
        path === "/api/admin/assessment-book" &&
        request.method === "POST"
    ) {
        return handleAdminAssessmentBook(
            request,
            env,
            ctx
        );
    }

    return null;
}


/*
 * =========================================================
 * DATABASE HELPERS
 * =========================================================
 */

async function dbRun(
    db,
    sql,
    params = []
) {
    let statement =
        db.prepare(sql);

    if (params.length) {
        statement =
            statement.bind(
                ...params
            );
    }

    return statement.run();
}


async function dbFirst(
    db,
    sql,
    params = []
) {
    let statement =
        db.prepare(sql);

    if (params.length) {
        statement =
            statement.bind(
                ...params
            );
    }

    return statement.first();
}


async function dbAll(
    db,
    sql,
    params = []
) {
    let statement =
        db.prepare(sql);

    if (params.length) {
        statement =
            statement.bind(
                ...params
            );
    }

    const result =
        await statement.all();

    return result?.results || [];
}


function positiveInteger(
    value
) {
    const number =
        Number(value);

    if (
        !Number.isSafeInteger(number) ||
        number <= 0
    ) {
        return null;
    }

    return number;
}


function integerOrZero(
    value
) {
    const number =
        Number(value);

    if (
        !Number.isSafeInteger(number) ||
        number < 0
    ) {
        return null;
    }

    return number;
}


function clean(
    value
) {
    if (
        value === undefined ||
        value === null
    ) {
        return "";
    }

    return String(value).trim();
}


function normalizeAssessmentType(
    value
) {
    const type =
        String(value || "")
            .trim()
            .toLowerCase();

    if (
        type === "test" ||
        type === "exam"
    ) {
        return type;
    }

    return null;
}


function hasOwn(
    object,
    key
) {
    return Object.prototype
        .hasOwnProperty
        .call(
            object || {},
            key
        );
}


function normalizeDateValue(
    value
) {
    if (
        value === null ||
        value === ""
    ) {
        return {
            ok: true,
            value: null
        };
    }

    const date =
        new Date(
            String(value)
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return {
            ok: false,
            value: null
        };
    }

    return {
        ok: true,
        value:
            date.toISOString()
    };
}


/*
 * =========================================================
 * MIGRATION
 * =========================================================
 */

async function ensureColumn(
    db,
    table,
    column,
    definition
) {
    const columns =
        await dbAll(
            db,
            `PRAGMA table_info(${table})`
        );

    const exists =
        columns.some(
            item =>
                item.name === column
        );

    if (!exists) {
        await dbRun(
            db,
            `
            ALTER TABLE ${table}
            ADD COLUMN ${column} ${definition}
            `
        );
    }
}


async function ensureAssessmentInfrastructure(
    db
) {
    /*
     * Books.
     */

    await dbRun(
        db,
        `
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            course_id INTEGER NOT NULL,
            program_id INTEGER,
            semester_id INTEGER,
            subject_id INTEGER,

            title TEXT NOT NULL,
            author TEXT,
            description TEXT,
            cover_key TEXT,

            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            FOREIGN KEY (course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE,

            FOREIGN KEY (program_id)
                REFERENCES programs(id)
                ON DELETE SET NULL,

            FOREIGN KEY (semester_id)
                REFERENCES semesters(id)
                ON DELETE SET NULL,

            FOREIGN KEY (subject_id)
                REFERENCES subjects(id)
                ON DELETE SET NULL
        )
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_books_course
        ON books(course_id)
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_books_subject
        ON books(subject_id)
        `
    );

    /*
     * Existing content gets optional book_id.
     */

    await ensureColumn(
        db,
        "lessons",
        "book_id",
        "INTEGER"
    );

    await ensureColumn(
        db,
        "tests",
        "book_id",
        "INTEGER"
    );

    await ensureColumn(
        db,
        "exams",
        "book_id",
        "INTEGER"
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_lessons_book
        ON lessons(book_id)
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_tests_book
        ON tests(book_id)
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_exams_book
        ON exams(book_id)
        `
    );

    /*
     * Individual access / retakes.
     */

    await dbRun(
        db,
        `
        CREATE TABLE IF NOT EXISTS assessment_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            assessment_type TEXT NOT NULL
                CHECK (
                    assessment_type IN (
                        'test',
                        'exam'
                    )
                ),

            assessment_id INTEGER NOT NULL,

            /*
             * NULL = inherit global state.
             * 0 = explicitly closed.
             * 1 = explicitly open.
             */
            is_open INTEGER,

            extra_attempts INTEGER
                NOT NULL DEFAULT 0,

            opens_at TEXT,
            closes_at TEXT,

            reason TEXT,

            granted_by INTEGER,

            created_at TEXT
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            updated_at TEXT
                NOT NULL DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(
                user_id,
                assessment_type,
                assessment_id
            ),

            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY (granted_by)
                REFERENCES users(id)
                ON DELETE SET NULL
        )
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_assessment_access_user
        ON assessment_access(user_id)
        `
    );

    await dbRun(
        db,
        `
        CREATE INDEX IF NOT EXISTS
        idx_assessment_access_item
        ON assessment_access(
            assessment_type,
            assessment_id
        )
        `
    );

    /*
     * Make sure custom grading scales exist
     * even on older databases.
     */

    await dbRun(
        db,
        `
        CREATE TABLE IF NOT EXISTS grading_scales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            course_id INTEGER NOT NULL,

            name TEXT NOT NULL,

            min_score INTEGER NOT NULL,
            max_score INTEGER NOT NULL,

            grade TEXT NOT NULL,
            description TEXT,

            FOREIGN KEY (course_id)
                REFERENCES courses(id)
                ON DELETE CASCADE
        )
        `
    );
}


/*
 * =========================================================
 * BOOKS
 * =========================================================
 */

async function getBook(
    db,
    bookId
) {
    return dbFirst(
        db,
        `
        SELECT
            b.*,

            c.name AS course_name,

            s.name AS subject_name

        FROM books b

        LEFT JOIN courses c
            ON c.id = b.course_id

        LEFT JOIN subjects s
            ON s.id = b.subject_id

        WHERE b.id = ?

        LIMIT 1
        `,
        [bookId]
    );
}


async function handleBooks(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const url =
        new URL(request.url);

    const courseId =
        positiveInteger(
            url.searchParams.get(
                "course_id"
            )
        );

    const subjectId =
        positiveInteger(
            url.searchParams.get(
                "subject_id"
            )
        );

    const where = [
        "b.is_active = 1"
    ];

    const params = [];

    if (courseId) {
        where.push(
            "b.course_id = ?"
        );

        params.push(
            courseId
        );
    }

    if (subjectId) {
        where.push(
            "b.subject_id = ?"
        );

        params.push(
            subjectId
        );
    }

    const books =
        await dbAll(
            env.DB,
            `
            SELECT
                b.*,

                c.name AS course_name,

                s.name AS subject_name

            FROM books b

            LEFT JOIN courses c
                ON c.id = b.course_id

            LEFT JOIN subjects s
                ON s.id = b.subject_id

            WHERE
                ${where.join(" AND ")}

            ORDER BY
                b.sort_order,
                b.id
            `,
            params
        );

    return ctx.json(
        {
            ok: true,
            books
        },
        200,
        env
    );
}


async function handleAdminBookCreate(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    try {
        const body =
            await request.json();

        const courseId =
            positiveInteger(
                body?.course_id
            );

        let subjectId =
            positiveInteger(
                body?.subject_id
            );

        let programId =
            positiveInteger(
                body?.program_id
            );

        let semesterId =
            positiveInteger(
                body?.semester_id
            );

        const title =
            clean(
                body?.title
            );

        const author =
            clean(
                body?.author
            );

        const description =
            clean(
                body?.description
            );

        const coverKey =
            clean(
                body?.cover_key
            );

        const sortOrder =
            Number.isSafeInteger(
                Number(body?.sort_order)
            )
                ? Number(body.sort_order)
                : 0;

        if (!courseId) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u043a\u0443\u0440\u0441"
                },
                400,
                env
            );
        }

        if (!title) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043a\u043d\u0438\u0433\u0438"
                },
                400,
                env
            );
        }

        const course =
            await dbFirst(
                env.DB,
                `
                SELECT id
                FROM courses
                WHERE id = ?
                LIMIT 1
                `,
                [courseId]
            );

        if (!course) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u041a\u0443\u0440\u0441 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
                },
                404,
                env
            );
        }

        if (subjectId) {
            const subject =
                await dbFirst(
                    env.DB,
                    `
                    SELECT
                        id,
                        course_id,
                        program_id,
                        semester_id

                    FROM subjects

                    WHERE id = ?

                    LIMIT 1
                    `,
                    [subjectId]
                );

            if (
                !subject ||
                Number(
                    subject.course_id
                ) !== courseId
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041f\u0440\u0435\u0434\u043c\u0435\u0442 \u043d\u0435 \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0441\u044f \u043a \u044d\u0442\u043e\u043c\u0443 \u043a\u0443\u0440\u0441\u0443"
                    },
                    400,
                    env
                );
            }

            programId =
                programId ||
                positiveInteger(
                    subject.program_id
                );

            semesterId =
                semesterId ||
                positiveInteger(
                    subject.semester_id
                );
        }

        const result =
            await dbRun(
                env.DB,
                `
                INSERT INTO books (
                    course_id,
                    program_id,
                    semester_id,
                    subject_id,
                    title,
                    author,
                    description,
                    cover_key,
                    sort_order,
                    is_active
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
                )
                `,
                [
                    courseId,
                    programId,
                    semesterId,
                    subjectId,
                    title,
                    author || null,
                    description || null,
                    coverKey || null,
                    sortOrder
                ]
            );

        const book =
            await getBook(
                env.DB,
                Number(
                    result.meta.last_row_id
                )
            );

        return ctx.json(
            {
                ok: true,
                book
            },
            201,
            env
        );

    } catch (error) {
        console.error(
            "Book create error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0437\u0434\u0430\u0442\u044c \u043a\u043d\u0438\u0433\u0443"
            },
            500,
            env
        );
    }
}


async function handleAdminBookUpdate(
    request,
    env,
    ctx,
    bookId
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const existing =
        await getBook(
            env.DB,
            bookId
        );

    if (!existing) {
        return ctx.json(
            {
                ok: false,
                error:
                    "\u041a\u043d\u0438\u0433\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
            },
            404,
            env
        );
    }

    try {
        const body =
            await request.json();

        const fields = [];
        const values = [];

        if (hasOwn(body, "title")) {
            const value =
                clean(body.title);

            if (!value) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043a\u043d\u0438\u0433\u0438 \u043d\u0435 \u043c\u043e\u0436\u0435\u0442 \u0431\u044b\u0442\u044c \u043f\u0443\u0441\u0442\u044b\u043c"
                    },
                    400,
                    env
                );
            }

            fields.push(
                "title = ?"
            );

            values.push(
                value
            );
        }

        if (hasOwn(body, "author")) {
            fields.push(
                "author = ?"
            );

            values.push(
                clean(body.author) ||
                null
            );
        }

        if (hasOwn(body, "description")) {
            fields.push(
                "description = ?"
            );

            values.push(
                clean(body.description) ||
                null
            );
        }

        if (hasOwn(body, "cover_key")) {
            fields.push(
                "cover_key = ?"
            );

            values.push(
                clean(body.cover_key) ||
                null
            );
        }

        if (hasOwn(body, "sort_order")) {
            const value =
                Number(body.sort_order);

            if (
                !Number.isSafeInteger(
                    value
                )
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "Invalid sort_order"
                    },
                    400,
                    env
                );
            }

            fields.push(
                "sort_order = ?"
            );

            values.push(
                value
            );
        }

        if (hasOwn(body, "is_active")) {
            fields.push(
                "is_active = ?"
            );

            values.push(
                body.is_active
                    ? 1
                    : 0
            );
        }

        if (hasOwn(body, "subject_id")) {
            const subjectId =
                positiveInteger(
                    body.subject_id
                );

            if (
                body.subject_id !== null &&
                body.subject_id !== "" &&
                !subjectId
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "Invalid subject_id"
                    },
                    400,
                    env
                );
            }

            if (subjectId) {
                const subject =
                    await dbFirst(
                        env.DB,
                        `
                        SELECT
                            id,
                            course_id,
                            program_id,
                            semester_id

                        FROM subjects

                        WHERE id = ?

                        LIMIT 1
                        `,
                        [subjectId]
                    );

                if (
                    !subject ||
                    Number(
                        subject.course_id
                    ) !==
                    Number(
                        existing.course_id
                    )
                ) {
                    return ctx.json(
                        {
                            ok: false,
                            error:
                                "\u041f\u0440\u0435\u0434\u043c\u0435\u0442 \u043d\u0435 \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0441\u044f \u043a \u043a\u0443\u0440\u0441\u0443 \u043a\u043d\u0438\u0433\u0438"
                        },
                        400,
                        env
                    );
                }

                fields.push(
                    "subject_id = ?",
                    "program_id = ?",
                    "semester_id = ?"
                );

                values.push(
                    subjectId,
                    subject.program_id ||
                        null,
                    subject.semester_id ||
                        null
                );

            } else {
                fields.push(
                    "subject_id = ?"
                );

                values.push(
                    null
                );
            }
        }

        if (!fields.length) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u041d\u0435\u0442 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439"
                },
                400,
                env
            );
        }

        values.push(
            bookId
        );

        await dbRun(
            env.DB,
            `
            UPDATE books
            SET
                ${fields.join(", ")},
                updated_at =
                    CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            values
        );

        return ctx.json(
            {
                ok: true,
                book:
                    await getBook(
                        env.DB,
                        bookId
                    )
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Book update error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043a\u043d\u0438\u0433\u0443"
            },
            500,
            env
        );
    }
}


async function handleAdminBookDelete(
    request,
    env,
    ctx,
    bookId
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const existing =
        await getBook(
            env.DB,
            bookId
        );

    if (!existing) {
        return ctx.json(
            {
                ok: false,
                error:
                    "\u041a\u043d\u0438\u0433\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
            },
            404,
            env
        );
    }

    /*
     * Soft delete keeps old grades/history valid.
     */

    await dbRun(
        env.DB,
        `
        UPDATE books
        SET
            is_active = 0,
            updated_at =
                CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [bookId]
    );

    return ctx.json(
        {
            ok: true
        },
        200,
        env
    );
}


/*
 * =========================================================
 * ASSESSMENT DEFINITIONS
 * =========================================================
 */

async function getAssessmentDefinition(
    db,
    type,
    assessmentId
) {
    const normalized =
        normalizeAssessmentType(
            type
        );

    if (!normalized) {
        return null;
    }

    const table =
        normalized === "test"
            ? "tests"
            : "exams";

    return dbFirst(
        db,
        `
        SELECT
            a.id,
            a.course_id,
            a.program_id,
            a.semester_id,
            a.subject_id,
            a.book_id,

            a.title,
            a.max_score,
            a.passing_score,
            a.attempts_allowed,

            a.is_active,
            a.starts_at,
            a.ends_at,

            c.name AS course_name,

            s.name AS subject_name,

            b.title AS book_title,
            b.author AS book_author

        FROM ${table} a

        LEFT JOIN courses c
            ON c.id = a.course_id

        LEFT JOIN subjects s
            ON s.id = a.subject_id

        LEFT JOIN books b
            ON b.id = a.book_id

        WHERE a.id = ?

        LIMIT 1
        `,
        [assessmentId]
    );
}


/*
 * =========================================================
 * ACCESS / RETAKE STATE
 * =========================================================
 */

function dateAllows(
    opensAt,
    closesAt
) {
    const now =
        Date.now();

    if (opensAt) {
        const start =
            Date.parse(opensAt);

        if (
            Number.isFinite(start) &&
            now < start
        ) {
            return false;
        }
    }

    if (closesAt) {
        const end =
            Date.parse(closesAt);

        if (
            Number.isFinite(end) &&
            now > end
        ) {
            return false;
        }
    }

    return true;
}


async function getAssessmentAccessState(
    db,
    userId,
    type,
    assessmentId,
    definition = null
) {
    const normalized =
        normalizeAssessmentType(
            type
        );

    if (!normalized) {
        return null;
    }

    const item =
        definition ||
        await getAssessmentDefinition(
            db,
            normalized,
            assessmentId
        );

    if (!item) {
        return null;
    }

    const override =
        await dbFirst(
            db,
            `
            SELECT *
            FROM assessment_access

            WHERE user_id = ?
              AND assessment_type = ?
              AND assessment_id = ?

            LIMIT 1
            `,
            [
                userId,
                normalized,
                assessmentId
            ]
        );

    const attemptTable =
        normalized === "test"
            ? "test_attempts"
            : "exam_attempts";

    const foreignKey =
        normalized === "test"
            ? "test_id"
            : "exam_id";

    const usedRow =
        await dbFirst(
            db,
            `
            SELECT
                COUNT(*) AS count
            FROM ${attemptTable}

            WHERE user_id = ?
              AND ${foreignKey} = ?
            `,
            [
                userId,
                assessmentId
            ]
        );

    const attemptsUsed =
        Number(
            usedRow?.count
        ) || 0;

    const baseAttempts =
        Math.max(
            1,
            Number(
                item.attempts_allowed
            ) || 1
        );

    const extraAttempts =
        Math.max(
            0,
            Number(
                override?.extra_attempts
            ) || 0
        );

    const totalAttempts =
        baseAttempts +
        extraAttempts;

    const attemptsRemaining =
        Math.max(
            0,
            totalAttempts -
            attemptsUsed
        );

    let isOpen =
        Number(
            item.is_active
        ) === 1;

    if (
        override &&
        override.is_open !==
            null &&
        override.is_open !==
            undefined
    ) {
        isOpen =
            Number(
                override.is_open
            ) === 1;
    }

    const opensAt =
        override?.opens_at ||
        item.starts_at ||
        null;

    const closesAt =
        override?.closes_at ||
        item.ends_at ||
        null;

    if (
        !dateAllows(
            opensAt,
            closesAt
        )
    ) {
        isOpen = false;
    }

    const canAttempt =
        isOpen &&
        attemptsRemaining > 0;

    return {
        assessment_type:
            normalized,

        assessment_id:
            Number(assessmentId),

        is_open:
            isOpen,

        base_attempts:
            baseAttempts,

        extra_attempts:
            extraAttempts,

        total_attempts:
            totalAttempts,

        attempts_used:
            attemptsUsed,

        attempts_remaining:
            attemptsRemaining,

        can_attempt:
            canAttempt,

        is_retake:
            attemptsUsed > 0,

        retake_available:
            attemptsUsed > 0 &&
            canAttempt,

        opens_at:
            opensAt,

        closes_at:
            closesAt,

        reason:
            override?.reason ||
            null,

        has_individual_override:
            Boolean(override)
    };
}


async function handleAssessmentAccess(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const url =
        new URL(request.url);

    const type =
        normalizeAssessmentType(
            url.searchParams.get(
                "type"
            )
        );

    const assessmentId =
        positiveInteger(
            url.searchParams.get(
                "assessment_id"
            )
        );

    if (
        !type ||
        !assessmentId
    ) {
        return ctx.json(
            {
                ok: false,
                error:
                    "\u0423\u043a\u0430\u0436\u0438\u0442\u0435 type \u0438 assessment_id"
            },
            400,
            env
        );
    }

    const definition =
        await getAssessmentDefinition(
            env.DB,
            type,
            assessmentId
        );

    if (!definition) {
        return ctx.json(
            {
                ok: false,
                error:
                    "\u0422\u0435\u0441\u0442 \u0438\u043b\u0438 \u044d\u043a\u0437\u0430\u043c\u0435\u043d \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
            },
            404,
            env
        );
    }

    const access =
        await getAssessmentAccessState(
            env.DB,
            auth.user.id,
            type,
            assessmentId,
            definition
        );

    return ctx.json(
        {
            ok: true,
            assessment:
                definition,
            access
        },
        200,
        env
    );
}


/*
 * =========================================================
 * ADMIN ACCESS
 * =========================================================
 */


/*
 * =========================================================
 * ADMIN ASSESSMENT DASHBOARD
 * =========================================================
 */

async function handleAdminAssessmentDashboard(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }


    try {

        const students =
            await dbAll(
                env.DB,
                `
                SELECT
                    id,
                    login,
                    username,
                    first_name,
                    last_name,
                    role,
                    status

                FROM users

                WHERE role = 'student'

                ORDER BY
                    first_name,
                    last_name,
                    login,
                    id
                `
            );


        const books =
            await dbAll(
                env.DB,
                `
                SELECT
                    b.id,
                    b.course_id,
                    b.subject_id,
                    b.title,
                    b.author,
                    b.is_active,

                    c.name AS course_name,

                    s.name AS subject_name

                FROM books b

                LEFT JOIN courses c
                    ON c.id = b.course_id

                LEFT JOIN subjects s
                    ON s.id = b.subject_id

                ORDER BY
                    c.name,
                    s.name,
                    b.sort_order,
                    b.title
                `
            );


        const tests =
            await dbAll(
                env.DB,
                `
                SELECT
                    t.id,
                    t.course_id,
                    t.subject_id,
                    t.book_id,

                    t.title,

                    t.max_score,
                    t.passing_score,
                    t.attempts_allowed,

                    t.is_active,
                    t.starts_at,
                    t.ends_at,

                    c.name AS course_name,

                    s.name AS subject_name,

                    b.title AS book_title

                FROM tests t

                LEFT JOIN courses c
                    ON c.id = t.course_id

                LEFT JOIN subjects s
                    ON s.id = t.subject_id

                LEFT JOIN books b
                    ON b.id = t.book_id

                ORDER BY
                    c.name,
                    s.name,
                    t.title
                `
            );


        const exams =
            await dbAll(
                env.DB,
                `
                SELECT
                    e.id,
                    e.course_id,
                    e.subject_id,
                    e.book_id,

                    e.title,

                    e.max_score,
                    e.passing_score,
                    e.attempts_allowed,

                    e.is_active,
                    e.starts_at,
                    e.ends_at,

                    c.name AS course_name,

                    s.name AS subject_name,

                    b.title AS book_title

                FROM exams e

                LEFT JOIN courses c
                    ON c.id = e.course_id

                LEFT JOIN subjects s
                    ON s.id = e.subject_id

                LEFT JOIN books b
                    ON b.id = e.book_id

                ORDER BY
                    c.name,
                    s.name,
                    e.title
                `
            );


        const overrides =
            await dbAll(
                env.DB,
                `
                SELECT
                    aa.*,

                    u.login,
                    u.username,
                    u.first_name,
                    u.last_name

                FROM assessment_access aa

                LEFT JOIN users u
                    ON u.id = aa.user_id

                ORDER BY
                    aa.updated_at DESC,
                    aa.id DESC
                `
            );


        return ctx.json(
            {
                ok: true,

                students,
                books,
                tests,
                exams,
                overrides
            },
            200,
            env
        );


    } catch (error) {

        console.error(
            "Assessment dashboard error:",
            error
        );


        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0434\u0430\u043d\u043d\u044b\u0435"
            },
            500,
            env
        );
    }
}


/*
 * =========================================================
 * ADMIN GET ONE STUDENT ACCESS STATE
 * =========================================================
 */

async function handleAdminAssessmentAccessState(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );


    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }


    const url =
        new URL(
            request.url
        );


    const userId =
        positiveInteger(
            url.searchParams.get(
                "user_id"
            )
        );


    const type =
        normalizeAssessmentType(
            url.searchParams.get(
                "type"
            )
        );


    const assessmentId =
        positiveInteger(
            url.searchParams.get(
                "assessment_id"
            )
        );


    if (
        !userId ||
        !type ||
        !assessmentId
    ) {

        return ctx.json(
            {
                ok: false,
                error:
                    "user_id, type and assessment_id are required"
            },
            400,
            env
        );
    }


    const user =
        await dbFirst(
            env.DB,
            `
            SELECT
                id,
                login,
                username,
                first_name,
                last_name,
                status

            FROM users

            WHERE id = ?

            LIMIT 1
            `,
            [
                userId
            ]
        );


    if (!user) {

        return ctx.json(
            {
                ok: false,
                error:
                    "\u0423\u0447\u0435\u043d\u0438\u043a \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
            },
            404,
            env
        );
    }


    const assessment =
        await getAssessmentDefinition(
            env.DB,
            type,
            assessmentId
        );


    if (!assessment) {

        return ctx.json(
            {
                ok: false,
                error:
                    "\u0422\u0435\u0441\u0442 \u0438\u043b\u0438 \u044d\u043a\u0437\u0430\u043c\u0435\u043d \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
            },
            404,
            env
        );
    }


    const access =
        await getAssessmentAccessState(
            env.DB,
            userId,
            type,
            assessmentId,
            assessment
        );


    return ctx.json(
        {
            ok: true,

            user,
            assessment,
            access
        },
        200,
        env
    );
}

async function handleAdminAssessmentAccessList(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const url =
        new URL(request.url);

    const userId =
        positiveInteger(
            url.searchParams.get(
                "user_id"
            )
        );

    const type =
        normalizeAssessmentType(
            url.searchParams.get(
                "type"
            )
        );

    const assessmentId =
        positiveInteger(
            url.searchParams.get(
                "assessment_id"
            )
        );

    const where = [];
    const params = [];

    if (userId) {
        where.push(
            "aa.user_id = ?"
        );

        params.push(
            userId
        );
    }

    if (type) {
        where.push(
            "aa.assessment_type = ?"
        );

        params.push(
            type
        );
    }

    if (assessmentId) {
        where.push(
            "aa.assessment_id = ?"
        );

        params.push(
            assessmentId
        );
    }

    const rows =
        await dbAll(
            env.DB,
            `
            SELECT
                aa.*,

                u.username,
                u.first_name,
                u.last_name,
                u.login

            FROM assessment_access aa

            LEFT JOIN users u
                ON u.id = aa.user_id

            ${
                where.length
                    ? "WHERE " +
                      where.join(" AND ")
                    : ""
            }

            ORDER BY
                aa.updated_at DESC,
                aa.id DESC
            `,
            params
        );

    return ctx.json(
        {
            ok: true,
            access: rows
        },
        200,
        env
    );
}


async function handleAdminAssessmentAccessSave(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    try {
        const body =
            await request.json();

        const userId =
            positiveInteger(
                body?.user_id
            );

        const type =
            normalizeAssessmentType(
                body?.type ||
                body?.assessment_type
            );

        const assessmentId =
            positiveInteger(
                body?.assessment_id
            );

        if (
            !userId ||
            !type ||
            !assessmentId
        ) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u0443\u0447\u0435\u043d\u0438\u043a\u0430, \u0442\u0438\u043f \u0438 ID \u0440\u0430\u0431\u043e\u0442\u044b"
                },
                400,
                env
            );
        }

        const user =
            await dbFirst(
                env.DB,
                `
                SELECT id
                FROM users
                WHERE id = ?
                LIMIT 1
                `,
                [userId]
            );

        if (!user) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0423\u0447\u0435\u043d\u0438\u043a \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
                },
                404,
                env
            );
        }

        const definition =
            await getAssessmentDefinition(
                env.DB,
                type,
                assessmentId
            );

        if (!definition) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0422\u0435\u0441\u0442 \u0438\u043b\u0438 \u044d\u043a\u0437\u0430\u043c\u0435\u043d \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d"
                },
                404,
                env
            );
        }

        const current =
            await dbFirst(
                env.DB,
                `
                SELECT *
                FROM assessment_access

                WHERE user_id = ?
                  AND assessment_type = ?
                  AND assessment_id = ?

                LIMIT 1
                `,
                [
                    userId,
                    type,
                    assessmentId
                ]
            );

        let isOpen =
            current?.is_open ??
            null;

        if (
            hasOwn(
                body,
                "is_open"
            )
        ) {
            if (
                body.is_open === null
            ) {
                isOpen = null;
            } else {
                isOpen =
                    body.is_open
                        ? 1
                        : 0;
            }
        }

        let extraAttempts =
            Number(
                current?.extra_attempts
            ) || 0;

        if (
            hasOwn(
                body,
                "extra_attempts"
            )
        ) {
            const value =
                integerOrZero(
                    body.extra_attempts
                );

            if (
                value === null ||
                value > 20
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0445 \u043f\u043e\u043f\u044b\u0442\u043e\u043a \u043c\u043e\u0436\u0435\u0442 \u0431\u044b\u0442\u044c \u043e\u0442 0 \u0434\u043e 20"
                    },
                    400,
                    env
                );
            }

            extraAttempts =
                value;
        }

        let opensAt =
            current?.opens_at ||
            null;

        if (
            hasOwn(
                body,
                "opens_at"
            )
        ) {
            const parsed =
                normalizeDateValue(
                    body.opens_at
                );

            if (!parsed.ok) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041d\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u0434\u0430\u0442\u0430 \u043e\u0442\u043a\u0440\u044b\u0442\u0438\u044f"
                    },
                    400,
                    env
                );
            }

            opensAt =
                parsed.value;
        }

        let closesAt =
            current?.closes_at ||
            null;

        if (
            hasOwn(
                body,
                "closes_at"
            )
        ) {
            const parsed =
                normalizeDateValue(
                    body.closes_at
                );

            if (!parsed.ok) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041d\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u0434\u0430\u0442\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u044f"
                    },
                    400,
                    env
                );
            }

            closesAt =
                parsed.value;
        }

        if (
            opensAt &&
            closesAt &&
            Date.parse(opensAt) >
            Date.parse(closesAt)
        ) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0414\u0430\u0442\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u044f \u0434\u043e\u043b\u0436\u043d\u0430 \u0431\u044b\u0442\u044c \u043f\u043e\u0437\u0436\u0435 \u0434\u0430\u0442\u044b \u043e\u0442\u043a\u0440\u044b\u0442\u0438\u044f"
                },
                400,
                env
            );
        }

        const reason =
            hasOwn(
                body,
                "reason"
            )
                ? clean(body.reason) ||
                  null
                : current?.reason ||
                  null;

        await dbRun(
            env.DB,
            `
            INSERT INTO assessment_access (
                user_id,
                assessment_type,
                assessment_id,
                is_open,
                extra_attempts,
                opens_at,
                closes_at,
                reason,
                granted_by
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?
            )

            ON CONFLICT (
                user_id,
                assessment_type,
                assessment_id
            )
            DO UPDATE SET

                is_open =
                    excluded.is_open,

                extra_attempts =
                    excluded.extra_attempts,

                opens_at =
                    excluded.opens_at,

                closes_at =
                    excluded.closes_at,

                reason =
                    excluded.reason,

                granted_by =
                    excluded.granted_by,

                updated_at =
                    CURRENT_TIMESTAMP
            `,
            [
                userId,
                type,
                assessmentId,
                isOpen,
                extraAttempts,
                opensAt,
                closesAt,
                reason,
                auth.user.id
            ]
        );

        const access =
            await getAssessmentAccessState(
                env.DB,
                userId,
                type,
                assessmentId,
                definition
            );

        return ctx.json(
            {
                ok: true,
                assessment:
                    definition,
                access
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Assessment access save error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0434\u043e\u0441\u0442\u0443\u043f"
            },
            500,
            env
        );
    }
}


async function handleAdminAssessmentAccessDelete(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    const url =
        new URL(request.url);

    const userId =
        positiveInteger(
            url.searchParams.get(
                "user_id"
            )
        );

    const type =
        normalizeAssessmentType(
            url.searchParams.get(
                "type"
            )
        );

    const assessmentId =
        positiveInteger(
            url.searchParams.get(
                "assessment_id"
            )
        );

    if (
        !userId ||
        !type ||
        !assessmentId
    ) {
        return ctx.json(
            {
                ok: false,
                error:
                    "user_id, type and assessment_id are required"
            },
            400,
            env
        );
    }

    await dbRun(
        env.DB,
        `
        DELETE FROM assessment_access

        WHERE user_id = ?
          AND assessment_type = ?
          AND assessment_id = ?
        `,
        [
            userId,
            type,
            assessmentId
        ]
    );

    const definition =
        await getAssessmentDefinition(
            env.DB,
            type,
            assessmentId
        );

    const access =
        definition
            ? await getAssessmentAccessState(
                env.DB,
                userId,
                type,
                assessmentId,
                definition
            )
            : null;

    return ctx.json(
        {
            ok: true,
            access
        },
        200,
        env
    );
}


/*
 * =========================================================
 * GLOBAL OPEN/CLOSE
 * =========================================================
 */

async function handleAdminAssessmentState(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    try {
        const body =
            await request.json();

        const type =
            normalizeAssessmentType(
                body?.type ||
                body?.assessment_type
            );

        const assessmentId =
            positiveInteger(
                body?.assessment_id
            );

        if (
            !type ||
            !assessmentId
        ) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0423\u043a\u0430\u0436\u0438\u0442\u0435 type \u0438 assessment_id"
                },
                400,
                env
            );
        }

        const definition =
            await getAssessmentDefinition(
                env.DB,
                type,
                assessmentId
            );

        if (!definition) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0420\u0430\u0431\u043e\u0442\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
                },
                404,
                env
            );
        }

        const fields = [];
        const values = [];

        if (
            hasOwn(
                body,
                "is_active"
            )
        ) {
            fields.push(
                "is_active = ?"
            );

            values.push(
                body.is_active
                    ? 1
                    : 0
            );
        }

        if (
            hasOwn(
                body,
                "attempts_allowed"
            )
        ) {
            const value =
                positiveInteger(
                    body.attempts_allowed
                );

            if (
                !value ||
                value > 50
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u043f\u043e\u043f\u044b\u0442\u043e\u043a \u0434\u043e\u043b\u0436\u043d\u043e \u0431\u044b\u0442\u044c \u043e\u0442 1 \u0434\u043e 50"
                    },
                    400,
                    env
                );
            }

            fields.push(
                "attempts_allowed = ?"
            );

            values.push(
                value
            );
        }

        for (
            const key of [
                "starts_at",
                "ends_at"
            ]
        ) {
            if (
                hasOwn(
                    body,
                    key
                )
            ) {
                const parsed =
                    normalizeDateValue(
                        body[key]
                    );

                if (!parsed.ok) {
                    return ctx.json(
                        {
                            ok: false,
                            error:
                                "\u041d\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u0434\u0430\u0442\u0430"
                        },
                        400,
                        env
                    );
                }

                fields.push(
                    `${key} = ?`
                );

                values.push(
                    parsed.value
                );
            }
        }

        if (!fields.length) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u041d\u0435\u0442 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439"
                },
                400,
                env
            );
        }

        const table =
            type === "test"
                ? "tests"
                : "exams";

        values.push(
            assessmentId
        );

        await dbRun(
            env.DB,
            `
            UPDATE ${table}

            SET
                ${fields.join(", ")},
                updated_at =
                    CURRENT_TIMESTAMP

            WHERE id = ?
            `,
            values
        );

        return ctx.json(
            {
                ok: true,

                assessment:
                    await getAssessmentDefinition(
                        env.DB,
                        type,
                        assessmentId
                    )
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Assessment state error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0434\u043e\u0441\u0442\u0443\u043f"
            },
            500,
            env
        );
    }
}


/*
 * =========================================================
 * LINK ASSESSMENT TO BOOK
 * =========================================================
 */

async function handleAdminAssessmentBook(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireAdmin(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    try {
        const body =
            await request.json();

        const type =
            normalizeAssessmentType(
                body?.type ||
                body?.assessment_type
            );

        const assessmentId =
            positiveInteger(
                body?.assessment_id
            );

        const bookId =
            body?.book_id === null ||
            body?.book_id === ""
                ? null
                : positiveInteger(
                    body?.book_id
                );

        if (
            !type ||
            !assessmentId
        ) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "type and assessment_id are required"
                },
                400,
                env
            );
        }

        const definition =
            await getAssessmentDefinition(
                env.DB,
                type,
                assessmentId
            );

        if (!definition) {
            return ctx.json(
                {
                    ok: false,
                    error:
                        "\u0420\u0430\u0431\u043e\u0442\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
                },
                404,
                env
            );
        }

        if (bookId) {
            const book =
                await getBook(
                    env.DB,
                    bookId
                );

            if (!book) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041a\u043d\u0438\u0433\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
                    },
                    404,
                    env
                );
            }

            if (
                Number(book.course_id) !==
                Number(
                    definition.course_id
                )
            ) {
                return ctx.json(
                    {
                        ok: false,
                        error:
                            "\u041a\u043d\u0438\u0433\u0430 \u0438 \u0440\u0430\u0431\u043e\u0442\u0430 \u0434\u043e\u043b\u0436\u043d\u044b \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u044c\u0441\u044f \u043a \u043e\u0434\u043d\u043e\u043c\u0443 \u043a\u0443\u0440\u0441\u0443"
                    },
                    400,
                    env
                );
            }
        }

        const table =
            type === "test"
                ? "tests"
                : "exams";

        await dbRun(
            env.DB,
            `
            UPDATE ${table}

            SET
                book_id = ?,
                updated_at =
                    CURRENT_TIMESTAMP

            WHERE id = ?
            `,
            [
                bookId,
                assessmentId
            ]
        );

        return ctx.json(
            {
                ok: true,

                assessment:
                    await getAssessmentDefinition(
                        env.DB,
                        type,
                        assessmentId
                    )
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Assessment book link error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u0438\u0432\u044f\u0437\u0430\u0442\u044c \u043a\u043d\u0438\u0433\u0443"
            },
            500,
            env
        );
    }
}


/*
 * =========================================================
 * GRADING
 * =========================================================
 */

function defaultGrade(
    percentage
) {
    const value =
        Math.max(
            0,
            Math.min(
                100,
                Number(percentage) || 0
            )
        );

    if (value >= 90) {
        return "\u041e\u0442\u043b\u0438\u0447\u043d\u043e";
    }

    if (value >= 75) {
        return "\u0425\u043e\u0440\u043e\u0448\u043e";
    }

    if (value >= 60) {
        return "\u0423\u0434\u043e\u0432\u043b\u0435\u0442\u0432\u043e\u0440\u0438\u0442\u0435\u043b\u044c\u043d\u043e";
    }

    return "\u041d\u0435 \u0441\u0434\u0430\u043d\u043e";
}


function resolveGrade(
    scales,
    courseId,
    percentage,
    storedGrade = null
) {
    const value =
        Math.max(
            0,
            Math.min(
                100,
                Number(percentage) || 0
            )
        );

    const custom =
        scales.find(
            scale =>
                Number(
                    scale.course_id
                ) ===
                    Number(courseId) &&
                value >=
                    Number(
                        scale.min_score
                    ) &&
                value <=
                    Number(
                        scale.max_score
                    )
        );

    if (custom?.grade) {
        return custom.grade;
    }

    if (
        storedGrade &&
        clean(storedGrade)
    ) {
        return clean(
            storedGrade
        );
    }

    return defaultGrade(
        value
    );
}


function bestAttemptFromList(
    attempts
) {
    if (!attempts.length) {
        return null;
    }

    return [...attempts]
        .sort(
            (a, b) => {

                if (
                    b.percentage !==
                    a.percentage
                ) {
                    return (
                        b.percentage -
                        a.percentage
                    );
                }

                return (
                    b.attempt_number -
                    a.attempt_number
                );
            }
        )[0];
}


async function handleDetailedGrades(
    request,
    env,
    ctx
) {
    const auth =
        await ctx.requireUser(
            request,
            env
        );

    if (!auth.ok) {
        return ctx.authError(
            auth,
            env
        );
    }

    try {
        const scales =
            await dbAll(
                env.DB,
                `
                SELECT
                    course_id,
                    min_score,
                    max_score,
                    grade,
                    description

                FROM grading_scales

                ORDER BY
                    course_id,
                    min_score DESC
                `
            );

        const tests =
            await dbAll(
                env.DB,
                `
                SELECT
                    ta.id AS attempt_id,
                    ta.test_id AS assessment_id,
                    ta.attempt_number,
                    ta.score,
                    ta.max_score,
                    ta.percentage,
                    ta.passed,
                    ta.started_at,
                    ta.submitted_at,

                    t.course_id,
                    t.program_id,
                    t.semester_id,
                    t.subject_id,
                    t.book_id,
                    t.title,
                    t.passing_score,
                    t.attempts_allowed,
                    t.is_active,
                    t.starts_at,
                    t.ends_at,

                    c.name AS course_name,

                    s.name AS subject_name,

                    b.title AS book_title,
                    b.author AS book_author

                FROM test_attempts ta

                JOIN tests t
                    ON t.id = ta.test_id

                LEFT JOIN courses c
                    ON c.id = t.course_id

                LEFT JOIN subjects s
                    ON s.id = t.subject_id

                LEFT JOIN books b
                    ON b.id = t.book_id

                WHERE ta.user_id = ?
                  AND ta.submitted_at
                      IS NOT NULL

                ORDER BY
                    ta.submitted_at DESC,
                    ta.id DESC
                `,
                [auth.user.id]
            );

        const exams =
            await dbAll(
                env.DB,
                `
                SELECT
                    ea.id AS attempt_id,
                    ea.exam_id AS assessment_id,
                    ea.attempt_number,
                    ea.score,
                    ea.max_score,
                    ea.percentage,
                    ea.passed,
                    ea.grade AS stored_grade,
                    ea.started_at,
                    ea.submitted_at,

                    e.course_id,
                    e.program_id,
                    e.semester_id,
                    e.subject_id,
                    e.book_id,
                    e.title,
                    e.passing_score,
                    e.attempts_allowed,
                    e.is_active,
                    e.starts_at,
                    e.ends_at,

                    c.name AS course_name,

                    s.name AS subject_name,

                    b.title AS book_title,
                    b.author AS book_author

                FROM exam_attempts ea

                JOIN exams e
                    ON e.id = ea.exam_id

                LEFT JOIN courses c
                    ON c.id = e.course_id

                LEFT JOIN subjects s
                    ON s.id = e.subject_id

                LEFT JOIN books b
                    ON b.id = e.book_id

                WHERE ea.user_id = ?
                  AND ea.submitted_at
                      IS NOT NULL

                ORDER BY
                    ea.submitted_at DESC,
                    ea.id DESC
                `,
                [auth.user.id]
            );

        const attempts = [];

        for (
            const row of tests
        ) {
            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(
                            row.percentage
                        ) || 0
                    )
                );

            const passingScore =
                Number(
                    row.passing_score
                ) || 60;

            attempts.push({
                type:
                    "test",

                attempt_id:
                    Number(
                        row.attempt_id
                    ),

                assessment_id:
                    Number(
                        row.assessment_id
                    ),

                attempt_number:
                    Number(
                        row.attempt_number
                    ) || 1,

                score:
                    Number(
                        row.score
                    ) || 0,

                max_score:
                    Number(
                        row.max_score
                    ) || 100,

                percentage,

                passing_score:
                    passingScore,

                passed:
                    percentage >=
                    passingScore,

                grade:
                    resolveGrade(
                        scales,
                        row.course_id,
                        percentage
                    ),

                started_at:
                    row.started_at ||
                    null,

                submitted_at:
                    row.submitted_at ||
                    null,

                course_id:
                    Number(
                        row.course_id
                    ),

                course_name:
                    row.course_name ||
                    null,

                subject_id:
                    row.subject_id
                        ? Number(
                            row.subject_id
                        )
                        : null,

                subject_name:
                    row.subject_name ||
                    null,

                book_id:
                    row.book_id
                        ? Number(
                            row.book_id
                        )
                        : null,

                book_title:
                    row.book_title ||
                    null,

                book_author:
                    row.book_author ||
                    null,

                title:
                    row.title,

                attempts_allowed:
                    Number(
                        row.attempts_allowed
                    ) || 1,

                is_active:
                    Number(
                        row.is_active
                    ) || 0,

                starts_at:
                    row.starts_at ||
                    null,

                ends_at:
                    row.ends_at ||
                    null
            });
        }

        for (
            const row of exams
        ) {
            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(
                            row.percentage
                        ) || 0
                    )
                );

            const passingScore =
                Number(
                    row.passing_score
                ) || 60;

            attempts.push({
                type:
                    "exam",

                attempt_id:
                    Number(
                        row.attempt_id
                    ),

                assessment_id:
                    Number(
                        row.assessment_id
                    ),

                attempt_number:
                    Number(
                        row.attempt_number
                    ) || 1,

                score:
                    Number(
                        row.score
                    ) || 0,

                max_score:
                    Number(
                        row.max_score
                    ) || 100,

                percentage,

                passing_score:
                    passingScore,

                passed:
                    percentage >=
                    passingScore,

                grade:
                    resolveGrade(
                        scales,
                        row.course_id,
                        percentage,
                        row.stored_grade
                    ),

                started_at:
                    row.started_at ||
                    null,

                submitted_at:
                    row.submitted_at ||
                    null,

                course_id:
                    Number(
                        row.course_id
                    ),

                course_name:
                    row.course_name ||
                    null,

                subject_id:
                    row.subject_id
                        ? Number(
                            row.subject_id
                        )
                        : null,

                subject_name:
                    row.subject_name ||
                    null,

                book_id:
                    row.book_id
                        ? Number(
                            row.book_id
                        )
                        : null,

                book_title:
                    row.book_title ||
                    null,

                book_author:
                    row.book_author ||
                    null,

                title:
                    row.title,

                attempts_allowed:
                    Number(
                        row.attempts_allowed
                    ) || 1,

                is_active:
                    Number(
                        row.is_active
                    ) || 0,

                starts_at:
                    row.starts_at ||
                    null,

                ends_at:
                    row.ends_at ||
                    null
            });
        }

        const groups =
            new Map();

        for (
            const attempt of attempts
        ) {
            const key =
                attempt.type +
                ":" +
                attempt.assessment_id;

            if (
                !groups.has(key)
            ) {
                groups.set(
                    key,
                    []
                );
            }

            groups.get(
                key
            ).push(
                attempt
            );
        }

        const assessments = [];

        for (
            const [
                key,
                list
            ] of groups
        ) {
            const first =
                list[0];

            const definition = {
                id:
                    first.assessment_id,

                course_id:
                    first.course_id,

                subject_id:
                    first.subject_id,

                book_id:
                    first.book_id,

                title:
                    first.title,

                attempts_allowed:
                    first.attempts_allowed,

                is_active:
                    first.is_active,

                starts_at:
                    first.starts_at,

                ends_at:
                    first.ends_at
            };

            const access =
                await getAssessmentAccessState(
                    env.DB,
                    auth.user.id,
                    first.type,
                    first.assessment_id,
                    definition
                );

            const sorted =
                [...list]
                    .sort(
                        (a, b) =>
                            a.attempt_number -
                            b.attempt_number
                    );

            const best =
                bestAttemptFromList(
                    list
                );

            assessments.push({
                key,

                type:
                    first.type,

                assessment_id:
                    first.assessment_id,

                title:
                    first.title,

                course: {
                    id:
                        first.course_id,

                    name:
                        first.course_name
                },

                subject: {
                    id:
                        first.subject_id,

                    name:
                        first.subject_name
                },

                book: {
                    id:
                        first.book_id,

                    title:
                        first.book_title,

                    author:
                        first.book_author
                },

                best_attempt:
                    best,

                attempts:
                    sorted,

                access
            });
        }

        assessments.sort(
            (a, b) => {

                const aDate =
                    Date.parse(
                        a.best_attempt
                            ?.submitted_at ||
                        ""
                    ) || 0;

                const bDate =
                    Date.parse(
                        b.best_attempt
                            ?.submitted_at ||
                        ""
                    ) || 0;

                return bDate - aDate;
            }
        );

        const bestAttempts =
            assessments
                .map(
                    item =>
                        item.best_attempt
                )
                .filter(Boolean);

        const total =
            bestAttempts.length;

        const passed =
            bestAttempts.filter(
                item =>
                    item.passed
            ).length;

        const average =
            total
                ? Math.round(
                    bestAttempts.reduce(
                        (
                            sum,
                            item
                        ) =>
                            sum +
                            item.percentage,
                        0
                    ) /
                    total
                )
                : 0;

        return ctx.json(
            {
                ok: true,

                summary: {
                    total,
                    passed,
                    failed:
                        total - passed,

                    average_percentage:
                        average,

                    average_grade:
                        defaultGrade(
                            average
                        )
                },

                assessments,

                attempts
            },
            200,
            env
        );

    } catch (error) {
        console.error(
            "Detailed grades error:",
            error
        );

        return ctx.json(
            {
                ok: false,
                error:
                    "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043e\u0446\u0435\u043d\u043a\u0438"
            },
            500,
            env
        );
    }
}