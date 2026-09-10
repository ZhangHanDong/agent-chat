mod common;

#[test]
fn native_owner_approval_recovery_crlf_fixture() {
    let schemas = [
        include_str!("../src/domain.sql"),
        include_str!("../src/migrations/002-role-publication.sql"),
        include_str!("../src/migrations/003-task-dispatch.sql"),
        include_str!("../src/migrations/004-message-inputs.sql"),
        include_str!("../src/migrations/005-task-intents.sql"),
        include_str!("../src/migrations/006-internal-conversations.sql"),
        include_str!("../src/migrations/007-peer-inputs.sql"),
        include_str!("../src/migrations/008-recovery-reports.sql"),
        include_str!("../src/migrations/009-conversation-lifecycle.sql"),
        include_str!("../src/migrations/010-task-graphs.sql"),
        include_str!("../src/migrations/011-final-replies.sql"),
    ];
    for crlf in [false, true] {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        for schema in schemas {
            db.execute_batch(schema).unwrap();
        }
        let source = schemas.last().unwrap().replace("\r\n", "\n");
        let source = if crlf {
            source.replace('\n', "\r\n")
        } else {
            source
        };
        let view = common::reply_route_view(&source);
        assert!(view.trim_end().ends_with(';'));
        assert!(!view.contains("CREATE TABLE final_replies"));
        db.execute_batch("DROP VIEW current_matrix_routes;")
            .unwrap();
        db.execute_batch(view).unwrap();
        db.prepare("SELECT session_id FROM current_matrix_routes LIMIT 0")
            .unwrap();
    }
}
