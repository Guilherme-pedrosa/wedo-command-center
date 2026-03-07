INSERT INTO storage.buckets (id, name, public) VALUES ('inter-certs', 'inter-certs', false) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Service role can manage inter-certs" ON storage.objects FOR ALL USING (bucket_id = 'inter-certs') WITH CHECK (bucket_id = 'inter-certs');