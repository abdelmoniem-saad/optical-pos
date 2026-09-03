import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import {
  useAddNote,
  useDeleteNote,
  useEveryoneNotes,
  useMarkNoteSeen,
  useMyNotes,
  useNoteSeen,
  useUpdateNote,
  type Note,
} from '../../data/notes'
import { useCurrentUser, useUsers } from '../../data/staff'
import { usePermissions } from '../../data/permissions'

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="mb-3">
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit()
        }}
        placeholder={t('Write a note…')}
        disabled={disabled}
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand disabled:opacity-60"
      />
      <div className="mt-1.5 flex justify-end">
        <button
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {t('Add')}
        </button>
      </div>
    </div>
  )
}

function NoteCard({
  note,
  canDelete,
  canEdit,
  authorName,
  seenByMe,
  seenNames,
  onMarkSeen,
}: {
  note: Note
  canDelete: boolean
  canEdit: boolean
  authorName?: string
  seenByMe?: boolean
  seenNames?: string[]
  onMarkSeen?: () => void
}) {
  const { t } = useI18n()
  const del = useDeleteNote()
  const upd = useUpdateNote()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)

  async function save() {
    const body = draft.trim()
    if (!body) return
    await upd.mutateAsync({ id: note.id, body })
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-brand-faint bg-white p-3 text-sm">
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded-md border border-line px-2 py-1.5 outline-none focus:border-brand"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            onClick={() => setEditing(false)}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={save}
            disabled={upd.isPending || !draft.trim()}
            className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            {upd.isPending ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-white p-3 text-sm shadow-sm">
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-faint">
        <span>{(note.created_at ?? '').slice(0, 16).replace('T', ' ')}</span>
        {note.updated_at && <span className="text-warning">· {t('edited')}</span>}
        {authorName && <span>· {authorName}</span>}
        <span className="ms-auto flex items-center gap-2">
          {canEdit && (
            <button
              onClick={() => {
                setDraft(note.body)
                setEditing(true)
              }}
              className="text-brand hover:underline"
            >
              ✎ {t('Edit')}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => del.mutate(note.id)}
              disabled={del.isPending}
              className="text-danger hover:underline disabled:opacity-40"
            >
              {t('Delete')}
            </button>
          )}
        </span>
      </div>

      {/* Seen / confirm receipt for PUBLIC notes: everyone can confirm, and the
          sender sees exactly who has read it. */}
      {onMarkSeen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line/40 pt-2">
          {seenByMe ? (
            <span className="text-xs font-semibold text-success">✓ {t('Seen')}</span>
          ) : (
            <button
              onClick={onMarkSeen}
              className="rounded-md bg-brand-bg px-2.5 py-1 text-xs font-semibold text-brand-dark hover:opacity-90"
            >
              ✓ {t('Mark as seen')}
            </button>
          )}
          {seenNames && seenNames.length > 0 && (
            <span className="text-xs text-faint">
              {t('Seen by')}: {seenNames.join('، ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function NotesPage() {
  const { t } = useI18n()
  const me = useCurrentUser()
  const perms = usePermissions()

  // The resolved STAFF row id (never the raw auth UUID) — this is what links
  // private notes to their owner, even on legacy-linked accounts like the
  // seeded admin. Using the raw auth UUID here is exactly why the admin could
  // not post private notes before.
  const meId = me.data?.id ?? null

  const mine = useMyNotes(meId)
  const everyone = useEveryoneNotes()
  const users = useUsers()
  const add = useAddNote()
  const markSeen = useMarkNoteSeen()

  const [myBody, setMyBody] = useState('')
  const [pubBody, setPubBody] = useState('')

  const canCreate = perms.can('notes.create' as never)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users.data ?? []) m.set(u.id, u.full_name || u.username)
    return m
  }, [users.data])

  const publicIds = useMemo(
    () => (everyone.data ?? []).map((n) => n.id),
    [everyone.data],
  )
  const seenRows = useNoteSeen(publicIds)
  const seenByNote = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of seenRows.data ?? []) {
      const list = m.get(s.note_id) ?? []
      list.push(s.user_id)
      m.set(s.note_id, list)
    }
    return m
  }, [seenRows.data])

  async function submit(scope: 'mine' | 'everyone') {
    const body = (scope === 'mine' ? myBody : pubBody).trim()
    if (!body) return
    await add.mutateAsync({ body, userId: scope === 'mine' ? meId : null })
    if (scope === 'mine') setMyBody('')
    else setPubBody('')
  }

  // Deletion: the author for their own notes; ONLY an admin for notes
  // addressed to everyone else.
  const canDelete = (n: Note) => perms.isAdmin || n.created_by === meId
  // Editing is for the AUTHOR only (admins keep deletion, not rewriting other
  // people's words). Edited notes show an edited tag.
  const canEdit = (n: Note) => n.created_by === meId

  const cls = 'rounded-xl border border-line bg-surface/40 p-4'

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-4 text-2xl font-semibold text-brand-dark">{t('Notes')}</h1>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Private notes */}
        <section className={cls}>
          <h2 className="mb-3 font-semibold text-brand-dark">📝 {t('My Notes')}</h2>
          <Composer
            value={myBody}
            onChange={setMyBody}
            onSubmit={() => submit('mine')}
            disabled={!canCreate}
          />
          {(mine.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-faint">{t('No notes yet.')}</p>
          ) : (
            <div className="space-y-2">
              {mine.data!.map((n) => (
                <NoteCard key={n.id} note={n} canDelete={canDelete(n)} canEdit={canEdit(n)} />
              ))}
            </div>
          )}
        </section>

        {/* Team-wide notes */}
        <section className={cls}>
          <h2 className="mb-3 font-semibold text-brand-dark">📢 {t('Everyone')}</h2>
          <Composer
            value={pubBody}
            onChange={setPubBody}
            onSubmit={() => submit('everyone')}
            disabled={!canCreate}
          />
          {(everyone.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-faint">{t('No notes yet.')}</p>
          ) : (
            <div className="space-y-2">
              {everyone.data!.map((n) => {
                const seenUsers = seenByNote.get(n.id) ?? []
                return (
                  <NoteCard
                    key={n.id}
                    note={n}
                    canDelete={canDelete(n)}
                    canEdit={canEdit(n)}
                    authorName={n.created_by ? nameById.get(n.created_by) : undefined}
                    seenByMe={!!meId && seenUsers.includes(meId)}
                    seenNames={seenUsers.map((id) => nameById.get(id) ?? '-')}
                    onMarkSeen={
                      meId && !seenUsers.includes(meId)
                        ? () => markSeen.mutate({ noteId: n.id, userId: meId })
                        : undefined
                    }
                  />
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
