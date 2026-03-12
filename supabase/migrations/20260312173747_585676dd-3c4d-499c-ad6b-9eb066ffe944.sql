-- Create bucket if not exists and make it public for downloads
INSERT INTO storage.buckets (id, name, public)
VALUES ('nf-xmls', 'nf-xmls', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Allow anyone to upload/upsert files to nf-xmls bucket
CREATE POLICY "Allow public upload to nf-xmls"
ON storage.objects
FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'nf-xmls');

-- Allow anyone to update (upsert) files in nf-xmls bucket
CREATE POLICY "Allow public update to nf-xmls"
ON storage.objects
FOR UPDATE
TO anon, authenticated
USING (bucket_id = 'nf-xmls')
WITH CHECK (bucket_id = 'nf-xmls');

-- Allow anyone to read files from nf-xmls bucket
CREATE POLICY "Allow public read from nf-xmls"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'nf-xmls');