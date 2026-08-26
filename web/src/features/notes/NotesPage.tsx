import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { useAuth } from '../../lib/auth'
import {
  useAddNote,
  useDeleteNote,
  useEveryoneNotes,
  useMyNotes,
  type Note,
} from '../../data/notes'
import { useUsers } from '../../data/staff'
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
  authorName,
}: {
  note: Note
  canDelete: boolean
  authorName?: string
}) {
  const { t } = useI18n()
  const del = useDeleteNote()
  return (
    <div className="rounded-lg border border-line bg-white p-3 text-sm shadow-sm">
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
      <div className="mt-2 flex items-center gap-3 text-xs text-faint">
        <span>{(note.created_at ?? '').slice(0, 16).replace('T', ' ')}</span>
        {authorName && <span>· {authorName}</span>}
        {canDelete && (
          <button
            onClick={() => del.mutate(note.id)}
            disabled={del.isPending}
            className="ms-auto text-danger hover:underline disabled:opacity-40"
          >
            {t('Delete')}
          </button>
        )}
      </div>
    </div>
  )
}

export function NotesPage() {
  const { t } = useI18n()
  const { user } = useAuth()
  const meId = user?.id ?? null
  const perms = usePermissions()

  const mine = useMyNotes(meId)
  const everyone = useEveryoneNotes()
  const users = useUsers()
  const add = useAddNote()

  const [myBody, setMyBody] = useState('')
  const [pubBody, setPubBody] = useState('')

  const canCreate = perms.can('notes.create')

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users.data ?? []) m.set(u.id, u.full_name || u.username)
    return m
  }, [users.data])

  async function submit(scope: 'mine' | 'everyone') {
    const body = (scope === 'mine' ? myBody : pubBody).trim()
    if (!body) return
    await add.mutateAsync({ body, userId: scope === 'mine' ? meId : null })
    if (scope === 'mine') setMyBody('')
    else setPubBody('')
  }

  /** Author or admin can remove; private notes are always theirs. */
  const canRemove = (n: Note) =>
    perms.isAdmin || perms.can('notes.delete') || n.created_by === meId

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
                <NoteCard key={n.id} note={n} canDelete={canCreate || canRemove(n)} />
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
              {everyone.data!.map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  canDelete={canRemove(n)}
                  authorName={n.created_by ? nameById.get(n.created_by) : undefined}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
