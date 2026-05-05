import * as q from "q";
import * as stream from "stream";
import { Client } from "pg";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as storage from "./storage";

import Promise = q.Promise;

export class SupabaseStorage implements storage.Storage {
    private _db: Client;
    private _s3: S3Client;
    private _bucket: string;

    constructor(dbConfig: string, s3Config: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
        this._db = new Client({ connectionString: dbConfig });
        this._s3 = new S3Client({
            endpoint: s3Config.endpoint,
            region: s3Config.region,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: true,
        });
        this._bucket = s3Config.bucket;
        this._db.connect();
    }

    public checkHealth(): Promise<void> {
        return q.Promise<void>((resolve, reject) => {
            this._db.query("SELECT 1", (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    // --- Accounts ---

    public addAccount(account: storage.Account): Promise<string> {
        return this._qquery(
            "INSERT INTO public.accounts (name, email, created_time) VALUES ($1, $2, $3) RETURNING id",
            [account.name, account.email, account.createdTime || Date.now()]
        ).then(res => res.rows[0].id);
    }

    public getAccount(accountId: string): Promise<storage.Account> {
        return this._qquery("SELECT * FROM public.accounts WHERE id = $1", [accountId])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                const row = res.rows[0];
                return { id: row.id, name: row.name, email: row.email, createdTime: Number(row.created_time) };
            });
    }

    public getAccountByEmail(email: string): Promise<storage.Account> {
        return this._qquery("SELECT * FROM public.accounts WHERE email = $1", [email])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                const row = res.rows[0];
                return { id: row.id, name: row.name, email: row.email, createdTime: Number(row.created_time) };
            });
    }

    public getAccountIdFromAccessKey(accessKey: string): Promise<string> {
        return this._qquery("SELECT account_id FROM public.access_keys WHERE name = $1", [accessKey])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                return res.rows[0].account_id;
            });
    }

    public updateAccount(email: string, updates: storage.Account): Promise<void> {
        return this._qquery("UPDATE public.accounts SET name = $1 WHERE email = $2", [updates.name, email]).then(() => {});
    }

    // --- Apps ---

    public addApp(accountId: string, app: storage.App): Promise<storage.App> {
        return this._qquery(
            "INSERT INTO public.apps (account_id, name, created_time) VALUES ($1, $2, $3) RETURNING id",
            [accountId, app.name, app.createdTime || Date.now()]
        ).then(res => {
            const appId = res.rows[0].id;
            return this.addCollaborator(accountId, appId, "").then(() => {
                return { ...app, id: appId };
            });
        });
    }

    public getApps(accountId: string): Promise<storage.App[]> {
        return this._qquery(
            "SELECT a.*, c.permission FROM public.apps a JOIN public.collaborators c ON a.id = c.app_id WHERE c.account_id = $1",
            [accountId]
        ).then(res => res.rows.map(row => {
            const collabs: storage.CollaboratorMap = {};
            collabs["owner@example.com"] = { permission: row.permission, isCurrentAccount: true };
            return { id: row.id, name: row.name, createdTime: Number(row.created_time), collaborators: collabs };
        }));
    }

    public getApp(accountId: string, appId: string): Promise<storage.App> {
        return this._qquery(
            "SELECT a.*, c.permission FROM public.apps a JOIN public.collaborators c ON a.id = c.app_id WHERE c.account_id = $1 AND a.id = $2",
            [accountId, appId]
        ).then(res => {
            if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
            const row = res.rows[0];
            const collabs: storage.CollaboratorMap = {};
            collabs["owner@example.com"] = { permission: row.permission, isCurrentAccount: true };
            return { id: row.id, name: row.name, createdTime: Number(row.created_time), collaborators: collabs };
        });
    }

    public removeApp(accountId: string, appId: string): Promise<void> {
        return this._qquery("DELETE FROM public.apps WHERE id = $1 AND account_id = $2", [appId, accountId]).then(() => {});
    }

    public transferApp(accountId: string, appId: string, email: string): Promise<void> {
        return this.getAccountByEmail(email).then(newOwner => {
            return this._qquery("UPDATE public.apps SET account_id = $1 WHERE id = $2 AND account_id = $3", [newOwner.id, appId, accountId]).then(() => {});
        });
    }

    public updateApp(accountId: string, app: storage.App): Promise<void> {
        return this._qquery("UPDATE public.apps SET name = $1 WHERE id = $2 AND account_id = $3", [app.name, app.id, accountId]).then(() => {});
    }

    // --- Collaborators ---

    public addCollaborator(accountId: string, appId: string, email: string): Promise<void> {
        const targetAccountIdPromise = email ? this.getAccountByEmail(email).then(acc => acc.id) : q.resolve(accountId);
        return targetAccountIdPromise.then(accId => {
            return this._qquery(
                "INSERT INTO public.collaborators (app_id, account_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
                [appId, accId, email ? storage.Permissions.Collaborator : storage.Permissions.Owner]
            ).then(() => {});
        });
    }

    public getCollaborators(accountId: string, appId: string): Promise<storage.CollaboratorMap> {
        return this._qquery(
            "SELECT c.permission, a.email FROM public.collaborators c JOIN public.accounts a ON c.account_id = a.id WHERE c.app_id = $1",
            [appId]
        ).then(res => {
            const map: storage.CollaboratorMap = {};
            res.rows.forEach(row => {
                map[row.email] = { permission: row.permission };
            });
            return map;
        });
    }

    public removeCollaborator(accountId: string, appId: string, email: string): Promise<void> {
        return this.getAccountByEmail(email).then(acc => {
            return this._qquery("DELETE FROM public.collaborators WHERE app_id = $1 AND account_id = $2", [appId, acc.id]).then(() => {});
        });
    }

    // --- Deployments ---

    public addDeployment(accountId: string, appId: string, deployment: storage.Deployment): Promise<string> {
        return this._qquery(
            "INSERT INTO public.deployments (app_id, name, key, created_time) VALUES ($1, $2, $3, $4) RETURNING id",
            [appId, deployment.name, deployment.key, deployment.createdTime || Date.now()]
        ).then(res => res.rows[0].id);
    }

    public getDeployment(accountId: string, appId: string, deploymentId: string): Promise<storage.Deployment> {
        return this._qquery("SELECT * FROM public.deployments WHERE id = $1 AND app_id = $2", [deploymentId, appId])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                const row = res.rows[0];
                return { id: row.id, name: row.name, key: row.key, createdTime: Number(row.created_time) };
            });
    }

    public getDeploymentInfo(deploymentKey: string): Promise<storage.DeploymentInfo> {
        return this._qquery("SELECT id, app_id FROM public.deployments WHERE key = $1", [deploymentKey])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                return { appId: res.rows[0].app_id, deploymentId: res.rows[0].id };
            });
    }

    public getDeployments(accountId: string, appId: string): Promise<storage.Deployment[]> {
        return this._qquery("SELECT * FROM public.deployments WHERE app_id = $1", [appId])
            .then(res => res.rows.map(row => ({ id: row.id, name: row.name, key: row.key, createdTime: Number(row.created_time) })));
    }

    public removeDeployment(accountId: string, appId: string, deploymentId: string): Promise<void> {
        return this._qquery("DELETE FROM public.deployments WHERE id = $1 AND app_id = $2", [deploymentId, appId]).then(() => {});
    }

    public updateDeployment(accountId: string, appId: string, deployment: storage.Deployment): Promise<void> {
        return this._qquery("UPDATE public.deployments SET name = $1 WHERE id = $2 AND app_id = $3", [deployment.name, deployment.id, appId]).then(() => {});
    }

    // --- Packages ---

    public commitPackage(accountId: string, appId: string, deploymentId: string, appPackage: storage.Package): Promise<storage.Package> {
        return this._qquery(
            `INSERT INTO public.packages (deployment_id, app_version, blob_url, description, is_disabled, is_mandatory, label, manifest_blob_url, package_hash, released_by, release_method, rollout, size, upload_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [deploymentId, appPackage.appVersion, appPackage.blobUrl, appPackage.description, appPackage.isDisabled, appPackage.isMandatory, appPackage.label, appPackage.manifestBlobUrl, appPackage.packageHash, appPackage.releasedBy, appPackage.releaseMethod, appPackage.rollout, appPackage.size, appPackage.uploadTime || Date.now()]
        ).then(res => this._mapPackage(res.rows[0]));
    }

    public getPackageHistory(accountId: string, appId: string, deploymentId: string): Promise<storage.Package[]> {
        return this._qquery("SELECT * FROM public.packages WHERE deployment_id = $1 ORDER BY upload_time DESC", [deploymentId])
            .then(res => res.rows.map(this._mapPackage));
    }

    public getPackageHistoryFromDeploymentKey(deploymentKey: string): Promise<storage.Package[]> {
        return this.getDeploymentInfo(deploymentKey).then(info => this.getPackageHistory("", info.appId, info.deploymentId));
    }

    public clearPackageHistory(accountId: string, appId: string, deploymentId: string): Promise<void> {
        return this._qquery("DELETE FROM public.packages WHERE deployment_id = $1", [deploymentId]).then(() => {});
    }

    public updatePackageHistory(accountId: string, appId: string, deploymentId: string, history: storage.Package[]): Promise<void> {
        // Simple implementation: clear and re-insert or update rollout
        return this.clearPackageHistory(accountId, appId, deploymentId).then(() => {
            const promises = history.map(pkg => this.commitPackage(accountId, appId, deploymentId, pkg));
            return q.all(promises).then(() => {});
        });
    }

    // --- Blobs (Supabase S3) ---

    public addBlob(blobId: string, addstream: stream.Readable, streamLength: number): Promise<string> {
        const chunks: any[] = [];
        return q.Promise<string>((resolve, reject) => {
            addstream.on("data", (chunk) => chunks.push(chunk));
            addstream.on("error", (err) => reject(err));
            addstream.on("end", () => {
                const buffer = Buffer.concat(chunks);
                const command = new PutObjectCommand({
                    Bucket: this._bucket,
                    Key: blobId,
                    Body: buffer,
                    ContentType: "application/zip",
                });
                this._s3.send(command)
                    .then(() => resolve(blobId))
                    .catch(reject);
            });
        });
    }

    public getBlobUrl(blobId: string): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this._bucket,
            Key: blobId,
        });
        // Generate a signed URL that lasts for 1 hour
        return q.Promise<string>((resolve, reject) => {
            getSignedUrl(this._s3, command, { expiresIn: 3600 })
                .then(resolve)
                .catch(reject);
        });
    }

    public removeBlob(blobId: string): Promise<void> {
        const command = new DeleteObjectCommand({
            Bucket: this._bucket,
            Key: blobId,
        });
        return q.Promise<void>((resolve, reject) => {
            this._s3.send(command).then(() => resolve()).catch(reject);
        });
    }

    // --- Access Keys ---

    public addAccessKey(accountId: string, accessKey: storage.AccessKey): Promise<string> {
        return this._qquery(
            "INSERT INTO public.access_keys (account_id, name, friendly_name, expires, created_time, created_by, is_session) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            [accountId, accessKey.name, accessKey.friendlyName, accessKey.expires, accessKey.createdTime || Date.now(), accessKey.createdBy, accessKey.isSession || false]
        ).then(res => res.rows[0].id);
    }

    public getAccessKey(accountId: string, accessKeyId: string): Promise<storage.AccessKey> {
        return this._qquery("SELECT * FROM public.access_keys WHERE id = $1 AND account_id = $2", [accessKeyId, accountId])
            .then(res => {
                if (res.rows.length === 0) throw storage.storageError(storage.ErrorCode.NotFound);
                return this._mapAccessKey(res.rows[0]);
            });
    }

    public getAccessKeys(accountId: string): Promise<storage.AccessKey[]> {
        return this._qquery("SELECT * FROM public.access_keys WHERE account_id = $1", [accountId])
            .then(res => res.rows.map(this._mapAccessKey));
    }

    public removeAccessKey(accountId: string, accessKeyId: string): Promise<void> {
        return this._qquery("DELETE FROM public.access_keys WHERE id = $1 AND account_id = $2", [accessKeyId, accountId]).then(() => {});
    }

    public updateAccessKey(accountId: string, accessKey: storage.AccessKey): Promise<void> {
        return this._qquery("UPDATE public.access_keys SET friendly_name = $1, expires = $2 WHERE id = $3 AND account_id = $4", [accessKey.friendlyName, accessKey.expires, accessKey.id, accountId]).then(() => {});
    }

    public dropAll(): Promise<void> {
        return this._qquery("TRUNCATE public.accounts, public.apps, public.collaborators, public.deployments, public.packages, public.access_keys CASCADE", []).then(() => {});
    }

    // --- Helpers ---

    private _qquery(text: string, params: any[]): Promise<any> {
        return q.Promise<any>((resolve, reject) => {
            this._db.query(text, params, (err, res) => {
                if (err) return reject(err);
                resolve(res);
            });
        });
    }

    private _mapPackage(row: any): storage.Package {
        return {
            appVersion: row.app_version,
            blobUrl: row.blob_url,
            description: row.description,
            isDisabled: row.is_disabled,
            isMandatory: row.is_mandatory,
            label: row.label,
            manifestBlobUrl: row.manifest_blob_url,
            packageHash: row.package_hash,
            releasedBy: row.released_by,
            releaseMethod: row.release_method,
            rollout: row.rollout,
            size: Number(row.size),
            uploadTime: Number(row.upload_time)
        };
    }

    private _mapAccessKey(row: any): storage.AccessKey {
        return {
            id: row.id,
            name: row.name,
            friendlyName: row.friendly_name,
            expires: Number(row.expires),
            createdTime: Number(row.created_time),
            createdBy: row.created_by,
            isSession: row.is_session
        };
    }
}
