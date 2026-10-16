-- Вставь это целиком в Supabase: SQL Editor → New query → Run

create table requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  note text,
  songs jsonb default '[]',
  status text
);

alter table requests enable row level security;

-- Ученики (без входа) могут только отправлять заявки
create policy "send" on requests for insert to anon with check (status is null);
-- Только ты (после входа) можешь читать, менять и удалять
create policy "read" on requests for select to authenticated using (true);
create policy "update" on requests for update to authenticated using (true);
create policy "delete" on requests for delete to authenticated using (true);

-- Хранилище для файлов (до 50 МБ каждый)
insert into storage.buckets (id, name, public, file_size_limit)
values ('songs', 'songs', true, 52428800);

create policy "upload songs" on storage.objects for insert to anon
with check (bucket_id = 'songs');
