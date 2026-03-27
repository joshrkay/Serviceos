from langgraph.graph import StateGraph, END
from .state import AgentState
from .nodes import classify_extract, resolve, score


def build_graph() -> StateGraph:
    """Build the 3-node LangGraph: classify_extract → resolve → score."""
    graph = StateGraph(AgentState)

    graph.add_node("classify_extract", classify_extract)
    graph.add_node("resolve", resolve)
    graph.add_node("score", score)

    graph.set_entry_point("classify_extract")
    graph.add_edge("classify_extract", "resolve")
    graph.add_edge("resolve", "score")
    graph.add_edge("score", END)

    return graph.compile()
