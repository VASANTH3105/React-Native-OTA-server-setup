-- Supabase SQL Schema for CodePush Server

-- Accounts Table
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_time BIGINT NOT NULL
);

-- Apps Table
CREATE TABLE IF NOT EXISTS apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES accounts(id),
    name TEXT NOT NULL,
    created_time BIGINT NOT NULL,
    UNIQUE(account_id, name)
);

-- Collaborators Table
CREATE TABLE IF NOT EXISTS collaborators (
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    permission TEXT NOT NULL, -- 'Owner' or 'Collaborator'
    PRIMARY KEY (app_id, account_id)
);

-- Deployments Table
CREATE TABLE IF NOT EXISTS deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_time BIGINT NOT NULL,
    UNIQUE(app_id, name)
);

-- Packages Table (Deployment History)
CREATE TABLE IF NOT EXISTS packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE,
    app_version TEXT NOT NULL,
    blob_url TEXT NOT NULL,
    description TEXT,
    is_disabled BOOLEAN DEFAULT FALSE,
    is_mandatory BOOLEAN DEFAULT FALSE,
    label TEXT,
    manifest_blob_url TEXT,
    package_hash TEXT,
    released_by TEXT,
    release_method TEXT,
    rollout INTEGER,
    size BIGINT,
    upload_time BIGINT NOT NULL
);

-- Access Keys Table
CREATE TABLE IF NOT EXISTS access_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT UNIQUE NOT NULL,
    friendly_name TEXT NOT NULL,
    expires BIGINT NOT NULL,
    created_time BIGINT NOT NULL,
    created_by TEXT,
    is_session BOOLEAN DEFAULT FALSE
);
