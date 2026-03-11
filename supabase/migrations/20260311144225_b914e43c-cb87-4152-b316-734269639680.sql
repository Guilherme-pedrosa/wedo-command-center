INSERT INTO storage.buckets (id, name, public) VALUES ('nf-xmls', 'nf-xmls', false) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow authenticated uploads to nf-xmls" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'nf-xmls');
CREATE POLICY "Allow authenticated reads from nf-xmls" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'nf-xmls');