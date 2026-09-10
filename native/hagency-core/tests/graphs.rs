use hagency_core::graphs::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Fixtures {
    conditions: Vec<ConditionCase>,
    transitions: Vec<TransitionCase>,
}
#[derive(Deserialize)]
struct ConditionCase {
    name: String,
    node: NodeDefinition,
    progress: BTreeMap<String, NodeProgress>,
    expected: Option<bool>,
}
#[derive(Deserialize)]
struct TransitionCase {
    name: String,
    graph: Graph,
    cancel: bool,
    expected: Value,
}
fn fixtures() -> Fixtures {
    serde_json::from_str(include_str!("../../fixtures/graphs.json")).unwrap()
}
fn value(v: impl serde::Serialize) -> Value {
    serde_json::to_value(v).unwrap()
}

#[test]
fn native_graph_condition_vectors() {
    let f = fixtures();
    assert!(f.conditions.len() >= 100);
    for c in f.conditions {
        assert_eq!(
            evaluate_condition(&c.node, &c.progress),
            c.expected,
            "{}",
            c.name
        );
    }
}
#[test]
fn native_graph_transition_vectors() {
    for c in fixtures().transitions {
        let original = value(&c.graph);
        let (next, assignments) = if c.cancel {
            (c.graph.cancel().unwrap(), vec![])
        } else {
            let t = c.graph.advance().unwrap();
            (t.graph, t.assignments)
        };
        assert_eq!(
            json!({"status":next.status,"progress":next.progress,"assignments":assignments}),
            c.expected,
            "{}",
            c.name
        );
        assert_eq!(value(&c.graph), original); // A proposal never commits itself.
        let replay = next.advance().unwrap();
        assert!(replay.assignments.is_empty());
    }
}
#[test]
fn native_graph_validation() {
    trait Ambiguous<A> {
        fn check() {}
    }
    impl<T: ?Sized> Ambiguous<()> for T {}
    impl<T: serde::de::DeserializeOwned> Ambiguous<u8> for T {}
    let _ = <NodeObservation as Ambiguous<_>>::check;
    let definition:GraphDefinition=serde_json::from_value(json!({"label":"测试","nodes":[{"id":"one","assignee":"小白","description":"Work"},{"id":"two","assignee":"Edison","description":"Review","depends_on":["one"]}]})).unwrap();
    let graph = Graph::new(definition.clone()).unwrap();
    assert!(
        graph
            .observe(
                "one",
                &NodeObservation::Complete {
                    result: json!(0.25)
                }
            )
            .is_err()
    );
    let first = graph.advance().unwrap();
    assert_eq!(first.assignments.len(), 1);
    let observed = first
        .graph
        .observe(
            "one",
            &NodeObservation::Complete {
                result: json!({"score":0.25}),
            },
        )
        .unwrap();
    let second = observed.advance().unwrap();
    assert_eq!(
        second.assignments[0].dependency_results[0].result["score"],
        0.25
    );
    assert!(observed.observe("one", &NodeObservation::Active).is_err());
    for case in [
        "empty",
        "duplicate",
        "missing",
        "self",
        "cycle",
        "condition_cycle",
        "too_many",
        "unknown_condition",
    ] {
        let mut d = definition.clone();
        match case {
            "empty" => d.nodes.clear(),
            "duplicate" => d.nodes[1].id = "one".into(),
            "missing" => d.nodes[1].depends_on = vec!["absent".into()],
            "self" => d.nodes[0].depends_on = vec!["one".into()],
            "cycle" => d.nodes[0].depends_on = vec!["two".into()],
            "condition_cycle" => {
                d.nodes[0].condition = Some(serde_json::from_value(json!({"dep":"two"})).unwrap())
            }
            "too_many" => d.nodes = vec![d.nodes[0].clone(); 129],
            _ => {
                d.nodes[0].condition =
                    Some(serde_json::from_value(json!({"execute":"command"})).unwrap())
            }
        }
        assert!(Graph::new(d).is_err(), "{case}");
    }
    let mut forged = value(&definition);
    forged["owner"] = json!("operator");
    assert!(serde_json::from_value::<GraphDefinition>(forged).is_err());
    let mut forged = value(&definition);
    forged["nodes"][0]["status"] = json!("complete");
    assert!(serde_json::from_value::<GraphDefinition>(forged).is_err());
    let mut deep = Value::Null;
    for _ in 0..66 {
        deep = json!([deep]);
    }
    assert!(validate_result(&deep).is_err());
    assert!(validate_result(&json!("中".repeat(30_000))).is_err());
    assert!(
        first
            .graph
            .observe("one", &NodeObservation::Complete { result: deep })
            .is_err()
    );
    let mut inconsistent = graph.clone();
    inconsistent.progress.remove("one");
    assert!(inconsistent.advance().is_err());
    let mut inconsistent = graph;
    inconsistent.status = GraphStatus::Complete;
    assert!(inconsistent.advance().is_err());
}
