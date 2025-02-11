import { error } from 'console';
import conn from '.';
import { getUserByAlias, getUserById, DbUser } from './users';
import { v4 as uuidv4 } from 'uuid';

export interface HunkInfo {
	author: string,
	timestamp?: string,
	line_start: number,
	line_end: number,
	filepath: string,
}

export interface DbHunks {
	repo_provider: string,
	repo_owner: string,
	repo_name: string,
	pr_number: string,
	author: string,
	hunks: {
		blamevec: HunkInfo[]
	}
}

export const saveHunk = async (hunkInfo: string) => {
	const hunkinfo_json = JSON.parse(hunkInfo);
	console.info("[saveHunk] Saving hunk for ", hunkinfo_json.repo_name);
	for (const prHunk of hunkinfo_json.prhunkvec) {
		const hunk_val = JSON.stringify({ "blamevec": prHunk.blamevec });
		const hunk_query = `
	  INSERT INTO hunks (repo_provider, repo_owner, 
		repo_name, review_id, author, hunks
		) VALUES ('${hunkinfo_json.repo_provider}',
			'${hunkinfo_json.repo_owner}', 
			'${hunkinfo_json.repo_name}',
			'${prHunk.pr_number}',
			'${prHunk.author}',
			'${hunk_val}')
		ON CONFLICT (repo_provider, repo_owner, repo_name, review_id) DO UPDATE SET 
		hunks = EXCLUDED.hunks
	`;
		await conn.query(hunk_query).catch(err => {
			console.error(`[saveHunk] Failed to insert hunks in the db`, { pg_query: hunk_query }, err);
		});
	}
}

export const getAuthorAliases = async (alias_email: string) => {
	const users = await getUserByAlias(alias_email);
	for (const user of users ?? []) {
		if (user["aliases"]) {
			return user["aliases"];
		}
	}
	console.error(`[getAuthorAliases] Failed to get author aliases from db of the user with alias ${alias_email}`);
	throw new Error('Cant proceed without author aliases'); //TODO - handle this more gracefully
}

export const getHunkData = async (provider: string, owner: string, repoName: string,
	reviewId: string, userEmails: Set<string>) => {
	const hunk_query = `
		SELECT hunks 
		FROM pr_hunks
		WHERE repo_provider = '${provider}' 
		AND repo_owner = '${owner}'
		AND repo_name = '${repoName}'  
		AND pr_number = '${reviewId}'
	`;
	const result = await conn.query<DbHunks>(hunk_query).catch(err => {
		console.error(`[getHunkData] Unable to get author and hunks from db for review-id ${reviewId} in the repository: ${provider}/${owner}/${repoName}`, { pg_query: hunk_query }, err);
		throw new Error("Unable to proceed without hunk data from db", err);
	});
	const filteredBlamevec = result.rows[0]["hunks"]["blamevec"].filter((obj: HunkInfo) => {
		const hunk_author = obj["author"];
		return userEmails.has(hunk_author);
	});
	return filteredBlamevec;
}

export const getReviewData = async (provider: string, owner: string, repoName: string, user_emails: Set<string>) => {
	const review_query = `
	SELECT pr_number, hunks 
	FROM pr_hunks
	WHERE repo_provider = '${provider}' 
	AND repo_owner = '${owner}'
	AND repo_name = '${repoName}'  
  `;
	const result = await conn.query<DbHunks>(review_query).catch(err => {
		console.error(`[getReviewData] Could not get hunks for repository: ${provider}/${owner}/${repoName}`, { pg_query: review_query }, err);
		throw new Error("Error in running the query on the database", err);
	});
	const filteredRows = result.rows.map(async (row) => {
		const filteredBlamevec = row["hunks"]["blamevec"].filter((obj: HunkInfo) => {
			const hunk_author = obj["author"].toString();
			return user_emails.has(hunk_author);
		});
		const reviewData = {
			review_id: row["pr_number"].toString(),
			blamevec: filteredBlamevec
		}
		return reviewData;
	});
	return filteredRows;
}

export const getFileData = async (provider: string, owner: string, reponame: string,
	review_id: string, author_emails: Set<string>) => {
	let hunks = await getHunkData(provider, owner, reponame, review_id, author_emails)
		.catch(err => {
			console.error(`[getFileData] Could not get hunks for repository: ${provider}/${owner}/${reponame}`, { pg_query: review_id }, err);
			return [];
		});
	let files = new Set<string>();
	for (const hunk of hunks) {
		files.add(hunk["filepath"]);
	}
	return files;
}

export const getTopicNameFromDB = async (owner: string, repoName: string, provider: string): Promise<string> => {
	console.log(`[getTopicNameFromDB] Getting topic name from db ${provider}/${owner}/${repoName}`); //TODO: To be removed
	const query = `
    SELECT install_id 
    FROM repos 
    WHERE repo_owner = '${owner}' AND repo_provider = '${provider}' AND repo_name = '${repoName}'
  `;
	const result = await conn.query(query).catch(err => {
		console.error(`[getTopicNameFromDB] Could not get the install-id for repository: ${provider}/${owner}/${repoName}`, { pg_query: query }, err);
		throw new Error("Error in running the query on the database", err);
	});
	if (result.rows.length === 0) {
		throw new Error('No topic found');
	}
	return result.rows[0].install_id;
}

export const saveTopicName = async (owner: string, provider: string, topicName: string, repoNames: string[]) => {
	const rows = repoNames.map(repo => `('${repo}', '${owner}', '${provider}', '${topicName}')`).join(', ');
	const query = `
        INSERT INTO repos (repo_name, repo_owner, repo_provider, install_id) 
        VALUES ${rows}
        ON CONFLICT (repo_name, repo_owner, repo_provider) DO UPDATE SET 
            install_id = EXCLUDED.install_id
    `;
	await conn.query(query).catch(err => {
		console.error(`[saveTopicName] Unable to insert topic name in db`, { pg_query: query }, err)
	});
}

export const createTopicName = async (user_id: string) => {
	console.info(`[createTopicName] creating topic name for user with id: ${user_id}`); 
	let topicName = "topic-" + uuidv4();
	if (!topicName) {
		console.error(`[createTopicName] could not create topic name`);
		return null;
	}
	return topicName;
}

export const saveTopicNameInUsersTable = async (userId: string, topicName: string) => {
	console.log(`[saveTopicNameInUsersTable] saving topic name: ${topicName} in users table in db for user_id:  ${userId}`); //TODO: To be removed
	const query = `
    Update users 
    set topic_name = $1 
    WHERE id = $2`;
	await conn.query(query, [topicName, userId]).catch(error => {
		console.error(`[saveTopicNameInUsersTable] Unable to insert topic name in db`, { pg_query: query }, error);
	});
}