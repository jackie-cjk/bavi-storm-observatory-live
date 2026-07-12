import { createRoot } from "react-dom/client";
import PokerGame from "../app/PokerGame";
import "../app/globals.css";

const host = document.getElementById("root");
if (!host) throw new Error("Static application root was not found");

createRoot(host).render(<PokerGame />);
